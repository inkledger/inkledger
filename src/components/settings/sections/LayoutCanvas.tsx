import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, Eye, EyeOff, GripVertical, Lock, MoreHorizontal, Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { surface } from "@/components/app/surface";
import { cn } from "@/lib/utils";
import { areaLabel } from "@/lib/workspace/labels";
import { blocksIn, heatClass, type Sketch, type SketchArea, type SketchAxis } from "@/lib/workspace/sketch";
import { useBlockDrag, type BlockDrag } from "@/lib/workspace/useBlockDrag";
import type { AnchorManifest, AreaManifest } from "@contracts/workspace/catalogTypes";
import type { ResolvedPlacement, Variant } from "@contracts/workspace/model";
import { t, type MessageKey } from "@/i18n";
import { AreaBlocks, PageSketch } from "./PageSketch";

const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;

/** What a block may do, and why not when it may not move: said on the block, not discovered by failing. */
export type BlockRules = { canMove: boolean; canReorder: boolean; canHide: boolean; canPin: boolean; variants: readonly Variant[]; locked: string | null };

export type CanvasActions = {
  visible: (anchorId: string, visible: boolean) => void;
  pinned: (anchorId: string, pinned: boolean) => void;
  variant: (anchorId: string, variant: Variant) => void;
  /** Put a block at `index` among the target area's other blocks (hidden ones included, as drawn). */
  place: (anchorId: string, areaId: string, index: number) => void;
  /** Whether that place is allowed, and if not why, in the user's words. */
  check: (anchorId: string, areaId: string, index: number) => { allowed: true } | { allowed: false; reason: string };
};

type Reorder = "up" | "down" | "first" | "last";

const HEIGHT: Record<Variant, string> = { compact: "min-h-9", default: "min-h-12", expanded: "min-h-16" };
const WIDTH: Record<Variant, string> = { compact: "min-w-24", default: "min-w-32", expanded: "min-w-40" };


/**
 * The Layout editor: the page drawn small with every block where it is, changed on the block itself.
 * Drag a block by its handle (or pick it up with Space and move it with the arrows) to another place;
 * the eye shows or hides it, the pin keeps it where it is, the menu sets its size and moves it too.
 */
export function LayoutCanvas({ sketch, placements, applied, areas, anchors, rules, busy, actions, label, usage = null, onAnnounce }: {
  sketch: Sketch;
  placements: readonly ResolvedPlacement[];
  /** The layout on screen now: blocks that differ in the preview are marked as changed. */
  applied: readonly ResolvedPlacement[];
  areas: readonly AreaManifest[];
  anchors: ReadonlyMap<string, AnchorManifest>;
  rules: (anchorId: string) => BlockRules;
  busy: boolean;
  actions: CanvasActions;
  /** A block's name, as the page writes it (with the user's tracker in it). */
  label: (anchorId: string) => string;
  /** How much each block was used (FlowMap), drawn on the blocks when given. */
  usage?: ReadonlyMap<string, number> | null;
  onAnnounce: (text: string) => void;
}) {
  const most = usage ? Math.max(1, ...usage.values()) : 1;
  const root = useRef<HTMLDivElement>(null);
  const editable = sketch.areas.filter(area => areas.some(item => item.id === area.areaId));
  const others = (areaId: string, anchorId: string) => blocksIn(placements, areaId).filter(placement => placement.anchorId !== anchorId);
  const describe = (drag: BlockDrag | null, what: "picked" | "moved" | "dropped" | "cancelled") => {
    if (!drag) return;
    const block = label(drag.anchorId);
    if (what === "picked") onAnnounce(t(key("pickedUp"), { block }));
    else if (what === "cancelled") onAnnounce(t(key("dragCancelled"), { block }));
    else if (what === "dropped") {
      const check = drag.targetAreaId ? actions.check(drag.anchorId, drag.targetAreaId, drag.index) : null;
      onAnnounce(check && !check.allowed ? check.reason : t(key("dropped"), { block }));
    }
    else if (drag.targetAreaId) {
      const check = actions.check(drag.anchorId, drag.targetAreaId, drag.index);
      const where = t(key("movedTo"), { block, area: areaLabel(drag.targetAreaId), position: drag.index + 1, count: others(drag.targetAreaId, drag.anchorId).length + 1 });
      onAnnounce(check.allowed ? where : `${where} ${check.reason}`);
    }
  };
  const { drag, onPointerDown, onKeyDown } = useBlockDrag({
    root,
    areas: editable.map(area => ({ areaId: area.areaId, axis: area.axis })),
    countIn: (areaId, anchorId) => others(areaId, anchorId).length,
    indexOf: (areaId, anchorId) => blocksIn(placements, areaId).findIndex(placement => placement.anchorId === anchorId),
    onDrop: next => {
      if (!next.targetAreaId) return;
      const before = blocksIn(placements, next.sourceAreaId).findIndex(placement => placement.anchorId === next.anchorId);
      if (next.targetAreaId === next.sourceAreaId && next.index === before) return;
      actions.place(next.anchorId, next.targetAreaId, next.index);
    },
    announce: describe,
  });

  // A block's buttons are disabled while its change is saved, and a disabled button drops the keyboard's
  // focus to the page: once saved, it goes back to the button the user pressed (or its block), never lost.
  const focused = useRef<{ anchorId: string; label: string | null } | null>(null);
  const remember = (event: React.FocusEvent<HTMLDivElement>) => {
    const anchorId = event.target.closest("[data-anchor]")?.getAttribute("data-anchor");
    focused.current = anchorId ? { anchorId, label: event.target.getAttribute("aria-label") } : null;
  };
  // Leaving for elsewhere on the page forgets it; a block's own menu (drawn outside) is still the block.
  const forget = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Element && !root.current?.contains(next) && !next.closest("[role='menu']")) focused.current = null;
  };
  const wasBusy = useRef(busy);
  useEffect(() => {
    const saved = wasBusy.current && !busy;
    wasBusy.current = busy;
    const last = focused.current;
    const active = document.activeElement;
    if (!saved || !last || (active && active !== document.body)) return;
    const block = [...(root.current?.querySelectorAll("[data-anchor]") ?? [])].find(element => element.getAttribute("data-anchor") === last.anchorId);
    const buttons = [...(block?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [])];
    (buttons.find(button => button.getAttribute("aria-label") === last.label) ?? buttons[0])?.focus({ preventScroll: true });
  }, [busy]);

  // Up, down, first and last count the blocks on screen: a hidden one is never a step.
  const reorderIndex = (placement: ResolvedPlacement, areaId: string, to: Reorder): number | null => {
    const rest = others(areaId, placement.anchorId);
    const visible = blocksIn(placements, areaId).filter(item => item.visible);
    const at = visible.indexOf(placement);
    if (at < 0) return null;
    const wanted = to === "up" ? at - 1 : to === "down" ? at + 1 : to === "first" ? 0 : visible.length - 1;
    if (wanted === at || wanted < 0 || wanted >= visible.length) return null;
    const restVisible = rest.filter(item => item.visible);
    return wanted < restVisible.length ? rest.indexOf(restVisible[wanted]) : rest.length;
  };
  const reorder = (placement: ResolvedPlacement, areaId: string, to: Reorder) => {
    const index = reorderIndex(placement, areaId, to);
    if (index !== null) actions.place(placement.anchorId, areaId, index);
  };

  const nested = (areaId: string) => {
    const area = sketch.areas.find(item => item.areaId === areaId && item.region === "nested");
    return area ? renderArea(area) : null;
  };
  const renderArea = (area: SketchArea): ReactNode => {
    const manifest = areas.find(item => item.id === area.areaId);
    if (!manifest) return null;
    const blocks = blocksIn(placements, area.areaId);
    const shown = blocks.filter(placement => placement.anchorId !== drag?.anchorId);
    const targeted = drag?.targetAreaId === area.areaId;
    const check = targeted && drag ? actions.check(drag.anchorId, area.areaId, drag.index) : null;
    const labelId = `workspace-area-${area.areaId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    const visibleCount = blocks.filter(placement => placement.visible).length;
    const slot = (
      // surface: none — the dashed slot where the moved block would land, not a box of its own
      <div key="slot" aria-hidden data-drop-slot className={cn("rounded-md border-2 border-dashed", check?.allowed === false ? "border-danger" : "border-primary", area.axis === "row" ? "min-h-9 min-w-24" : "min-h-9")} />
    );
    // One block as drawn, with the slot before it when the moved block would land there.
    const tileFor = (anchorId: string) => {
      const placement = blocks.find(item => item.anchorId === anchorId);
      if (!placement) return null;
      const moving = placement.anchorId === drag?.anchorId;
      // The slot goes before the block at the target index among the area's other blocks.
      const otherIndex = shown.indexOf(placement);
      return (
        <Fragment key={placement.anchorId}>
          {targeted && !moving && drag?.index === otherIndex && slot}
          <Block
            placement={placement}
            areaId={area.areaId}
            axis={area.axis}
            name={label(placement.anchorId)}
            overlay={area.region === "tray"}
            stacked={area.axis === "row" || area.axis === "tiles" || (area.region === "nested" && sketch.frame === "page")}
            anchor={anchors.get(placement.anchorId)}
            rules={rules(placement.anchorId)}
            changed={isChanged(placement, applied)}
            uses={usage ? usage.get(placement.anchorId) ?? 0 : null}
            most={most}
            busy={busy}
            areas={areas}
            actions={actions}
            reorder={to => reorder(placement, area.areaId, to)}
            canReorderTo={to => reorderIndex(placement, area.areaId, to) !== null}
            dragging={moving}
            onHandlePointerDown={event => onPointerDown(event, placement.anchorId, area.areaId)}
            onHandleKeyDown={event => onKeyDown(event, placement.anchorId, area.areaId)}
          />
        </Fragment>
      );
    };
    return (
      <section
        {...surface("ground")}
        aria-labelledby={labelId}
        data-drop-area={area.areaId}
        data-axis={area.axis}
        data-drop-state={check ? check.allowed ? "allowed" : "invalid" : undefined}
        className={cn("grid gap-1.5 rounded-md border p-1.5", check ? check.allowed ? "border-primary bg-primary-soft" : "border-danger bg-danger-soft" : "border-transparent")}
      >
        <div className="flex min-w-0 items-baseline justify-between gap-2">
          <h3 id={labelId} className="min-w-0 truncate text-caption font-medium">{areaLabel(area.areaId)}</h3>
          {area.region !== "tray" && (
            <span className="shrink-0 text-caption text-muted-foreground tabular-nums" title={t(key("areaCapacity"), { used: visibleCount, capacity: manifest.capacity })}>
              {visibleCount}/{manifest.capacity}
            </span>
          )}
        </div>
        {sketch.frame === "phone-page" && area.areaId === "dashboard.secondary" && <p className="text-caption text-muted-foreground">{t(key("railOnPhone"))}</p>}
        <AreaBlocks area={area} sketch={sketch} anchorIds={blocks.map(placement => placement.anchorId)} tileFor={tileFor} nested={nested} />
        {targeted && drag && drag.index >= shown.length && slot}
        {blocks.length === 0 && !targeted && <p className="text-caption text-muted-foreground">{t(key("emptyArea"))}</p>}
        {check && !check.allowed && <p role="status" className="text-caption text-danger">{check.reason}</p>}
      </section>
    );
  };

  return (
    <div ref={root} data-layout-canvas onFocus={remember} onBlur={forget}>
      <PageSketch sketch={sketch} renderArea={renderArea} />
    </div>
  );
}

function isChanged(placement: ResolvedPlacement, applied: readonly ResolvedPlacement[]): boolean {
  const before = applied.find(item => item.anchorId === placement.anchorId);
  return !before || before.areaId !== placement.areaId || before.order !== placement.order || before.visible !== placement.visible || before.variant !== placement.variant || before.pinned !== placement.pinned;
}

function Block({ placement, areaId, axis, name: block, overlay, stacked, anchor, rules, changed, uses, most, busy, areas, actions, reorder, canReorderTo, dragging, onHandlePointerDown, onHandleKeyDown }: {
  placement: ResolvedPlacement;
  areaId: string;
  axis: SketchAxis;
  name: string;
  /** A dialog over the page: it shows when opened, so it has no "hidden" state and no place to pin. */
  overlay: boolean;
  /** Narrow: the name on its own line, the buttons under it. */
  stacked: boolean;
  anchor: AnchorManifest | undefined;
  rules: BlockRules;
  changed: boolean;
  /** Times used, when use is shown (null: not shown). */
  uses: number | null;
  most: number;
  busy: boolean;
  areas: readonly AreaManifest[];
  actions: CanvasActions;
  reorder: (to: Reorder) => void;
  canReorderTo: (to: Reorder) => boolean;
  dragging: boolean;
  onHandlePointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onHandleKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}) {
  const labelId = `workspace-anchor-${placement.anchorId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const movable = (rules.canMove || rules.canReorder) && !busy;
  const targets = rules.canMove ? areas.filter(area => area.id !== areaId && actions.check(placement.anchorId, area.id, Number.MAX_SAFE_INTEGER).allowed) : [];
  const ghost = !placement.visible && !overlay;
  const handle = (
    <button
      type="button"
      aria-label={rules.locked ?? t(key("handle"), { block })}
      aria-describedby={rules.locked ? undefined : "workspace-canvas-hint"}
      aria-disabled={!movable || undefined}
      disabled={busy}
      onPointerDown={movable ? onHandlePointerDown : undefined}
      onKeyDown={movable ? onHandleKeyDown : undefined}
      title={rules.locked ?? undefined}
      className={cn(
        "flex size-target shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:size-touch",
        movable ? "cursor-grab touch-none hover:text-foreground active:cursor-grabbing" : "cursor-not-allowed",
      )}
    >
      {rules.locked ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <GripVertical className="h-4 w-4" aria-hidden />}
    </button>
  );
  const name = (
    <>
      <span id={labelId} className="min-w-0 flex-1 truncate text-body-sm" title={block}>{block}</span>
      {changed && <span role="img" aria-label={t(key("changed"))} title={t(key("changed"))} className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary-strong" />}
      {ghost && <span className="sr-only">{t(key("hidden"))}</span>}
      {uses !== null && uses > 0 && <span className="shrink-0 text-caption tabular-nums text-foreground" title={t(key("timelineBlock"), { block, count: uses })}>{t(key("usesShort"), { count: uses })}</span>}
    </>
  );
  const buttons = overlay ? null : (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t(key("showBlock"), { block })}
        aria-pressed={placement.visible}
        title={placement.visible ? t(key("visible")) : t(key("hidden"))}
        disabled={busy || !rules.canHide}
        onClick={() => actions.visible(placement.anchorId, !placement.visible)}
      >
        {placement.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t(key("pinBlock"), { block })}
        aria-pressed={placement.pinned}
        title={t(key("pinnedHint"))}
        disabled={busy || !rules.canPin}
        className={placement.pinned ? "text-primary-strong" : "text-muted-foreground"}
        onClick={() => actions.pinned(placement.anchorId, !placement.pinned)}
      >
        <Pin className={cn("h-4 w-4", placement.pinned && "fill-current")} />
      </Button>
    </>
  );
  const menu = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t(key("moreFor"), { block })} disabled={busy}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>{t(key("variant"))}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={placement.variant} onValueChange={value => actions.variant(placement.anchorId, value as Variant)}>
            {(anchor ? rules.variants : []).map(variant => (
              <DropdownMenuRadioItem key={variant} value={variant}>{t(key(`variants.${variant}`))}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {rules.canReorder && placement.visible && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!canReorderTo("up")} onSelect={() => reorder("up")}><ArrowUp className="h-4 w-4" />{t(key("up"))}</DropdownMenuItem>
              <DropdownMenuItem disabled={!canReorderTo("down")} onSelect={() => reorder("down")}><ArrowDown className="h-4 w-4" />{t(key("down"))}</DropdownMenuItem>
              <DropdownMenuItem disabled={!canReorderTo("first")} onSelect={() => reorder("first")}><ArrowUpToLine className="h-4 w-4" />{t(key("first"))}</DropdownMenuItem>
              <DropdownMenuItem disabled={!canReorderTo("last")} onSelect={() => reorder("last")}><ArrowDownToLine className="h-4 w-4" />{t(key("last"))}</DropdownMenuItem>
            </>
          )}
          {targets.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t(key("moveTo"))}</DropdownMenuLabel>
              {targets.map(area => (
                <DropdownMenuItem key={area.id} onSelect={() => actions.place(placement.anchorId, area.id, Number.MAX_SAFE_INTEGER)}>{areaLabel(area.id)}</DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
  );
  return (
    <div
      {...surface("control")}
      role="group"
      aria-labelledby={labelId}
      data-tile
      data-anchor={placement.anchorId}
      data-moving={dragging || undefined}
      data-visible={placement.visible}
      data-variant={placement.variant}
      className={cn(
        "min-w-0 rounded-md border p-0.5",
        uses !== null ? heatClass(uses, most) : "bg-card",
        stacked ? "grid content-between gap-0.5" : "flex items-center gap-0.5 pr-1",
        axis === "row" ? cn("flex-1", WIDTH[placement.variant]) : HEIGHT[placement.variant],
        ghost && "border-dashed bg-transparent text-muted-foreground",
        // Where it was, while it moves: outlined, its text as readable as ever.
        dragging && "border-dashed border-primary",
      )}
    >
      {stacked ? (
        <>
          <div className="flex min-w-0 items-center gap-0.5 pr-1">{handle}{name}</div>
          <div className="flex items-center justify-end gap-0.5">{buttons}{menu}</div>
        </>
      ) : (
        <>{handle}{name}{buttons}{menu}</>
      )}
    </div>
  );
}
