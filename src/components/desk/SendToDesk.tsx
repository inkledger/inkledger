import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { GripVertical, LayoutPanelLeft } from "lucide-react";
import { PRESETS, sameTarget, slotRects, zoneAt, type DeskPane, type PresetId, type SnapTarget } from "@contracts/desk";
import { cn } from "@/lib/utils";
import { layoutLabel } from "@/lib/desk/grid";
import { DESK_KEYS, slotLabel, useSendToDesk, WIDE } from "@/lib/desk/useSendToDesk";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { surface } from "@/components/app/surface";
import { LayoutMiniature } from "@/components/desk/LayoutPicker";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { t } from "@/i18n";

/** The screen's edge bands while the title is dragged (a share of the window): narrower than the desk's, the grip starts near the top. */
const EDGE_BAND = 0.1;
const START_DISTANCE = 6;

/**
 * The arrangements drawn small, each slot a button: the issue goes there. One Tab stop, the
 * arrows move from slot to slot (reading order, arrangement after arrangement).
 */
function LayoutSlots({ presets, issueKey, onPick, large = false }: { presets: PresetId[]; issueKey: string; onPick: (preset: PresetId, slot: number) => void; large?: boolean }) {
  const slots = presets.flatMap(preset => Array.from({ length: PRESETS[preset].slots }, (_, slot) => ({ preset, slot })));
  const [current, setCurrent] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? slots.length - 1 : step ? (current + step + slots.length) % slots.length : -1;
    if (to < 0) return;
    e.preventDefault();
    setCurrent(to);
    refs.current[to]?.focus();
  };
  let index = 0;
  return (
    <div role="group" aria-label={t("pages.desk.send.slots", { key: issueKey })} onKeyDown={onKeyDown} className={cn("grid grid-cols-3", large ? "gap-3" : "gap-2")}>
      {presets.map(preset => (
        <div key={preset} title={layoutLabel(preset)} className={cn("relative", large ? "aspect-[3/2] w-full" : "h-14 w-20")}>
          {slotRects(preset).map((rect, slot) => {
            const at = index++;
            return (
              // surface: none — a block of a drawing, not a box on the page.
              <button
                key={slot}
                ref={el => {
                  refs.current[at] = el;
                }}
                type="button"
                tabIndex={at === current ? 0 : -1}
                data-send-preset={preset}
                data-send-slot={slot}
                aria-label={slotLabel(preset, slot)}
                onFocus={() => setCurrent(at)}
                onClick={() => onPick(preset, slot)}
                className="absolute rounded-sm border border-muted-foreground/40 bg-muted outline-none transition-colors hover:border-primary-strong hover:bg-primary focus-visible:ring-2 focus-visible:ring-ring"
                style={{
                  left: `calc(${rect.x * 100}% + 1.5px)`,
                  top: `calc(${rect.y * 100}% + 1.5px)`,
                  width: `calc(${rect.w * 100}% - 3px)`,
                  height: `calc(${rect.h * 100}% - 3px)`,
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Hover opens it after a moment, like a window's snap layouts; leaving closes it. */
const HOVER_OPEN_MS = 500;
const HOVER_CLOSE_MS = 250;

/**
 * "Layout" beside Log time: the arrangements as miniatures, each slot a place to open this issue
 * in on the Desk. Opens on click, or after a moment under the mouse. On a phone, a sheet.
 */
export function SendToDeskButton({ pane, open, onOpenChange }: { pane: DeskPane; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { presets, prefetch, send } = useSendToDesk(pane);
  const wide = useMediaQuery(WIDE, typeof window === "undefined" || window.matchMedia(WIDE).matches);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onPointerEnter = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(timer.current);
    prefetch();
    timer.current = setTimeout(() => onOpenChange(true), HOVER_OPEN_MS);
  };
  const onPointerLeave = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onOpenChange(false), HOVER_CLOSE_MS);
  };
  const pick = (preset: PresetId, slot: number) => {
    onOpenChange(false);
    send(preset, slot);
  };
  const trigger = (onClick?: () => void) => (
    <Button variant="outline" onFocus={prefetch} onClick={onClick} title={t("pages.desk.send.title", { keys: DESK_KEYS })} aria-label={t("pages.desk.send.label", { key: pane.key })}>
      <LayoutPanelLeft className="h-4 w-4" aria-hidden />
      {t("pages.desk.layout")}
    </Button>
  );
  if (!wide)
    return (
      <>
        {trigger(() => onOpenChange(true))}
        <SendToDeskSheet pane={pane} open={open} onOpenChange={onOpenChange} presets={presets} onPick={pick} />
      </>
    );
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        clearTimeout(timer.current);
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
        {trigger()}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-3" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
        <p className="mb-2.5 text-body-sm font-medium">{t("pages.desk.send.heading", { key: pane.key })}</p>
        <LayoutSlots presets={presets} issueKey={pane.key} onPick={pick} />
        <p className="mt-3 max-w-64 text-caption text-muted-foreground [overflow-wrap:anywhere]">{t("pages.desk.send.hint", { keys: DESK_KEYS })}</p>
      </PopoverContent>
    </Popover>
  );
}

/** A phone: the miniatures in a sheet from the bottom (the Layout button, or a long press on the title). */
function SendToDeskSheet({ pane, open, onOpenChange, presets, onPick }: { pane: DeskPane; open: boolean; onOpenChange: (open: boolean) => void; presets: PresetId[]; onPick: (preset: PresetId, slot: number) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="gap-0">
        <SheetHeader>
          <SheetTitle>{t("pages.desk.send.heading", { key: pane.key })}</SheetTitle>
          <SheetDescription>{t("pages.desk.send.sheetDescription")}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">
          <LayoutSlots presets={presets} issueKey={pane.key} onPick={onPick} large />
        </div>
      </SheetContent>
    </Sheet>
  );
}

type PageDrag = { target: SnapTarget | null };
const GHOST_GAP = 14;
/** The picture of the issue beside the pointer, never under it (the place's name is there), flipped near the window's edges. */
function placeGhost(ghost: HTMLElement, point: { x: number; y: number }) {
  const x = point.x + GHOST_GAP + ghost.offsetWidth > window.innerWidth ? point.x - GHOST_GAP - ghost.offsetWidth : point.x + GHOST_GAP;
  const y = point.y + GHOST_GAP + ghost.offsetHeight > window.innerHeight ? point.y - GHOST_GAP - ghost.offsetHeight : point.y + GHOST_GAP;
  ghost.style.transform = `translate(${x}px, ${y}px)`;
}

/** What lies under the pointer while the title is dragged: a slot of the snap bar, else a band at the window's edges. */
function pageTargetAt(x: number, y: number, n: number): SnapTarget | null {
  const slot = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-snap-preset]");
  const preset = slot?.dataset.snapPreset as PresetId | undefined;
  if (slot && preset && PRESETS[preset]) return { kind: "slot", preset, slot: Number(slot.dataset.snapSlot) };
  return zoneAt({ x: x / window.innerWidth, y: y / window.innerHeight }, n, [], null, EDGE_BAND);
}

/**
 * The grip before an issue's title (wide screens): dragged towards an edge or a corner of the
 * window, the Desk's snap overlay shows where the issue would go, and the snap bar at the top
 * offers every arrangement; dropping there opens the Desk with it. Esc cancels. The keyboard
 * has the Layout button and Alt+Shift+arrows instead.
 */
export function TitleGrip({ pane }: { pane: DeskPane }) {
  const { n, presets, prefetch, send } = useSendToDesk(pane);
  const [drag, setDrag] = useState<PageDrag | null>(null);
  const ghost = useRef<HTMLDivElement>(null);
  // Where the pointer is: the picture beside it is moved there directly, never by a redraw.
  const pointer = useRef({ x: 0, y: 0 });
  const dragging = drag !== null;
  useLayoutEffect(() => {
    if (dragging && ghost.current) placeGhost(ghost.current, pointer.current);
  }, [dragging]);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const latest = useRef({ n, send });
  useEffect(() => {
    latest.current = { n, send };
  });

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || cleanup.current) return;
    event.preventDefault();
    prefetch();
    const origin = { x: event.clientX, y: event.clientY };
    let point = origin;
    let current: PageDrag | null = null;
    const place = () => {
      pointer.current = point;
      if (ghost.current) placeGhost(ghost.current, point);
      const target = pageTargetAt(point.x, point.y, latest.current.n);
      if (current && sameTarget(target, current.target)) return;
      current = { target };
      setDrag(current);
    };
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      point = { x: e.clientX, y: e.clientY };
      if (!current && Math.hypot(point.x - origin.x, point.y - origin.y) < START_DISTANCE) return;
      if (!current) document.documentElement.style.cursor = "grabbing";
      place();
    };
    const finish = (drop: boolean) => {
      const target = current?.target;
      cleanup.current?.();
      if (drop && target?.kind === "slot") latest.current.send(target.preset, target.slot);
    };
    const up = (e: globalThis.PointerEvent) => e.pointerId === event.pointerId && finish(true);
    const cancel = (e: globalThis.PointerEvent) => e.pointerId === event.pointerId && finish(false);
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      document.documentElement.style.cursor = "";
      setDrag(null);
      cleanup.current = null;
    };
  };

  const target = drag?.target;
  const rects = target?.kind === "slot" ? slotRects(target.preset) : [];
  const box = (rect: { x: number; y: number; w: number; h: number }) => ({
    left: `calc(${rect.x * 100}% + 8px)`,
    top: `calc(${rect.y * 100}% + 8px)`,
    width: `calc(${rect.w * 100}% - 16px)`,
    height: `calc(${rect.h * 100}% - 16px)`,
  });
  return (
    <>
      <button
        type="button"
        // The keyboard's ways are the Layout button and Alt+Shift+arrows: the grip is for the pointer.
        tabIndex={-1}
        aria-hidden
        data-title-grip
        title={t("pages.desk.send.gripTitle")}
        onPointerDown={onPointerDown}
        onPointerEnter={prefetch}
        className={cn(
          "-ml-2 hidden h-8 w-5 shrink-0 touch-none items-center justify-center rounded-md text-muted-foreground/70 outline-none transition-colors hover:bg-accent hover:text-foreground lg:flex",
          drag ? "cursor-grabbing bg-primary-soft text-primary-strong" : "cursor-grab"
        )}
      >
        <GripVertical className="h-4 w-4" aria-hidden />
      </button>
      {drag &&
        createPortal(
          <div aria-hidden data-snap-overlay className="pointer-events-none fixed inset-0 z-50">
            {target?.kind === "slot" &&
              rects.map((rect, slot) =>
                slot === target.slot ? (
                  // surface: none — a highlight drawn over the page for the length of a drag, not a box.
                  <div
                    key={`${target.preset}-${slot}`}
                    className="absolute flex items-center justify-center rounded-lg bg-primary-soft/80 ring-2 ring-inset ring-ring duration-DEFAULT animate-in fade-in-0"
                    style={box(rect)}
                  >
                    <span {...surface("chip")} className="max-w-[80%] truncate rounded-md border bg-card px-2.5 py-1 text-body-sm font-medium text-foreground shadow-xs">
                      {t("pages.desk.send.onDesk", { place: slotLabel(target.preset, target.slot) })}
                    </span>
                  </div>
                ) : (
                  // surface: none — the arrangement's other places, outlined: the desk's issues, or empty slots.
                  <div key={`${target.preset}-${slot}`} className="absolute rounded-lg border-2 border-dashed border-primary-strong/40 duration-DEFAULT animate-in fade-in-0" style={box(rect)} />
                )
              )}
            <div className="absolute inset-x-0 top-3 flex justify-center">
              <div {...surface("menu")} className="pointer-events-auto grid justify-items-center gap-1.5 rounded-lg border bg-popover px-3 pb-2 pt-2.5 shadow-sm duration-DEFAULT animate-in fade-in-0">
                <div className="flex items-center gap-2">
                  {presets.map(preset => (
                    <LayoutMiniature key={preset} preset={preset} targets active={target?.kind === "slot" && target.preset === preset ? target.slot : null} className="h-9 w-14" />
                  ))}
                </div>
                <p className="text-caption text-muted-foreground">{t("pages.desk.send.dragHint")}</p>
              </div>
            </div>
            <div ref={ghost} {...surface("chip")} className="fixed left-0 top-0 max-w-72 truncate rounded-md border bg-card px-2.5 py-1 text-body-sm font-semibold shadow-sm">
              {pane.key}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
