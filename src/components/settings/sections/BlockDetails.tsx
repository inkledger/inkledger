import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronRight, Eye, EyeOff, MousePointerClick, Pin, PinOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { surface } from "@/components/app/surface";
import { cn } from "@/lib/utils";
import type { BlockFriction, BlockUse } from "@/lib/workspace/layers";
import { frictionText } from "@/lib/workspace/labels";
import type { Variant } from "@contracts/workspace/model";
import { t, type MessageKey } from "@/i18n";

const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;

/** What the data layers can say: collection off, nothing in the period, or a period to read. */
export type DataState = "off" | "none" | "ok";

/** A path in words: the block (or place) at its other end, and how often. */
export type NamedPath = { id: string; name: string; count: number };

export type BlockInfo = {
  anchorId: string;
  name: string;
  area: string;
  visible: boolean;
  pinned: boolean;
  variant: Variant;
  /** A pop-up over the page: no hiding, no pinning, no order. */
  overlay: boolean;
  canHide: boolean;
  canPin: boolean;
  variants: readonly Variant[];
  /** Why it cannot move, in words (null: it can). */
  locked: string | null;
  canUp: boolean;
  canDown: boolean;
  moveTargets: readonly { id: string; name: string }[];
  rules: readonly { id: string; text: string }[];
  isNew: boolean;
  use: BlockUse | null;
  out: readonly NamedPath[];
  in: readonly NamedPath[];
  friction: BlockFriction | null;
};

export type BlockActions = {
  visible: (visible: boolean) => void;
  pinned: (pinned: boolean) => void;
  variant: (variant: Variant) => void;
  reorder: (to: "up" | "down") => void;
  moveTo: (areaId: string) => void;
  removeRule: (constraintId: string) => void;
  discovery: (placed: boolean) => void;
};

/** One part of the panel, under a hairline, with a small title. */
function Part({ title, children, label }: { title: string; children: ReactNode; label?: string }) {
  return (
    <section aria-label={label ?? title} className="grid gap-1.5 border-t py-3 first:border-t-0 first:pt-0">
      <h4 className="text-overline uppercase text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

/** "mouse 12 · keys 8": how a block was used, only the ways it was. */
function howText(use: BlockUse): string {
  return (["pointer", "touch", "keyboard", "unknown"] as const)
    .filter(modality => use.modalities[modality] > 0)
    .map(modality => `${t(key(`modalities.${modality}`))} ${use.modalities[modality]}`)
    .join(" · ");
}

function PathList({ label, paths }: { label: string; paths: readonly NamedPath[] }) {
  return (
    <div className="grid gap-1">
      <p className="text-caption text-muted-foreground">{label}</p>
      <ul aria-label={label} className="grid gap-0.5">
        {paths.map(path => (
          <li key={path.id} className="flex min-w-0 items-baseline justify-between gap-3 text-body-sm">
            <span className="min-w-0 truncate">{path.name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{path.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The selected block, and only it: where it is, how it was used in the period, where use goes from it
 * and comes to it from, where it went wrong, its rules, whether it is new, and the same changes as its
 * ⋯ menu (for touch and keyboard).
 */
export function BlockDetails({ block, data, period, busy, actions, onClose, titleId, closable = true, Title = "h3" }: {
  block: BlockInfo;
  data: DataState;
  period: string | null;
  busy: boolean;
  actions: BlockActions;
  onClose: () => void;
  titleId: string;
  /** False in a sheet: it has its own close button. */
  closable?: boolean;
  /** The element that names the panel (a sheet's own title names the sheet). */
  Title?: React.ElementType<{ id: string; className: string; children: ReactNode }>;
}) {
  const flags = [!block.visible && !block.overlay ? t(key("hidden")) : null, block.pinned ? t(key("pinned")) : null].filter((flag): flag is string => flag !== null);
  return (
    <div className="grid">
      <div className="flex min-w-0 items-start justify-between gap-2 pb-3">
        <div className="min-w-0">
          <Title id={titleId} className="font-display text-body font-semibold [overflow-wrap:anywhere]">{block.name}</Title>
          <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{[t(key("inArea"), { area: block.area }), ...flags].join(" · ")}</p>
        </div>
        {closable && <Button variant="ghost" size="icon-sm" aria-label={t(key("closeDetails"))} onClick={onClose}><X className="h-4 w-4" /></Button>}
      </div>

      {block.isNew && (
        <div data-discovery-anchor={block.anchorId} className="mb-3 grid gap-2 rounded-md bg-info-soft px-3 py-2">
          <p className="text-body-sm text-info">{t(key("newBlockHint"))}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => actions.discovery(true)}>{t(key("place"))}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => actions.discovery(false)}>{t(key("dismiss"))}</Button>
          </div>
        </div>
      )}

      <Part title={period ? t(key("useIn"), { period }) : t(key("layers.use"))} label={t(key("layers.use"))}>
        {data === "off" ? <p className="text-caption text-muted-foreground">{t(key("detailsOff"))}</p>
          : !block.use || block.use.clicks === 0 ? <p className="text-body-sm text-muted-foreground">{t(key("notUsed"))}</p>
            : (
              <>
                <p className="text-body-sm tabular-nums">{t(key("clicksSeen"), { count: block.use.clicks, seen: block.use.seen })}</p>
                <p className="flex items-center gap-1.5 text-caption tabular-nums text-muted-foreground"><MousePointerClick aria-hidden className="h-3.5 w-3.5" />{howText(block.use)}</p>
              </>
            )}
      </Part>

      {(block.out.length > 0 || block.in.length > 0) && (
        <Part title={t(key("layers.paths"))}>
          {block.out.length > 0 && <PathList label={t(key("pathsOut"))} paths={block.out} />}
          {block.in.length > 0 && <PathList label={t(key("pathsIn"))} paths={block.in} />}
        </Part>
      )}

      {block.friction && (
        <Part title={t(key("layers.friction"))}>
          <p className="text-body-sm text-warning tabular-nums">{frictionText(block.friction)}</p>
        </Part>
      )}

      {block.rules.length > 0 && (
        <Part title={t(key("rules"))}>
          <ul className="grid gap-1">
            {block.rules.map(rule => (
              <li key={rule.id} className="flex min-w-0 items-center justify-between gap-2 text-body-sm">
                <span className="min-w-0 [overflow-wrap:anywhere]">{rule.text}</span>
                <Button size="sm" variant="ghost" disabled={busy} aria-label={`${t(key("removeRule"))}: ${rule.text}`} onClick={() => actions.removeRule(rule.id)}>{t(key("removeRule"))}</Button>
              </li>
            ))}
          </ul>
        </Part>
      )}

      {!block.overlay && (
        <Part title={t(key("change"))}>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy || !block.canHide} onClick={() => actions.visible(!block.visible)}>
              {block.visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}{t(key(block.visible ? "hide" : "show"))}
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !block.canPin} onClick={() => actions.pinned(!block.pinned)}>
              {block.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}{t(key(block.pinned ? "unpin" : "pin"))}
            </Button>
            {(block.canUp || block.canDown) && (
              <>
                <Button size="sm" variant="outline" disabled={busy || !block.canUp} onClick={() => actions.reorder("up")}><ArrowUp className="h-4 w-4" />{t(key("up"))}</Button>
                <Button size="sm" variant="outline" disabled={busy || !block.canDown} onClick={() => actions.reorder("down")}><ArrowDown className="h-4 w-4" />{t(key("down"))}</Button>
              </>
            )}
          </div>
          {block.variants.length > 1 && (
            <SegmentedControl label={t(key("variant"))} value={block.variant} onChange={actions.variant} options={block.variants.map(variant => ({ value: variant, label: t(key(`variants.${variant}`)) }))} />
          )}
          {block.locked ? <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{block.locked}</p> : block.moveTargets.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-caption text-muted-foreground">{t(key("moveTo"))}</span>
              {block.moveTargets.map(area => <Button key={area.id} size="sm" variant="ghost" disabled={busy} onClick={() => actions.moveTo(area.id)}>{area.name}</Button>)}
            </div>
          )}
        </Part>
      )}
    </div>
  );
}

export type Gap = { id: string; label: string; detail: string; state: "unconfirmed" | "confirmed" | "rejected"; usable: boolean };
export type NewItem = { kind: "anchor" | "area"; id: string; name: string };
export type TableData = {
  use: readonly { id: string; name: string; clicks: number; seen: number }[];
  paths: readonly { id: string; from: string; to: string; count: number }[];
  friction: readonly { id: string; name: string; detail: string }[];
  gaps: readonly Gap[];
};

/**
 * Nothing selected: the page as a whole. Its most used blocks in the period, the things looked for
 * where they were not (each to judge, or to use), what is new, and how to see one block. The numbers
 * behind the layers are one disclosure away, as tables.
 */
export function PageSummary({ data, period, top, gaps, news, table, busy, onGap, onUseGap, onDiscovery }: {
  data: DataState;
  period: string | null;
  top: readonly { id: string; name: string; count: number }[];
  gaps: readonly Gap[];
  news: readonly NewItem[];
  table: TableData;
  busy: boolean;
  onGap: (gap: Gap, status: "confirmed" | "rejected") => void;
  onUseGap: (gap: Gap) => void;
  onDiscovery: (item: NewItem, placed: boolean) => void;
}) {
  const [tableOpen, setTableOpen] = useState(false);
  return (
    <div className="grid">
      <p className="pb-3 text-body-sm text-muted-foreground">{t(key("selectHint"))}</p>

      {data === "ok" && top.length > 0 && (
        <Part title={period ? t(key("useIn"), { period }) : t(key("layers.use"))} label={t(key("mostUsed"))}>
          <p className="text-caption text-muted-foreground">{t(key("mostUsed"))}</p>
          <ol aria-label={t(key("mostUsed"))} className="grid gap-0.5">
            {top.map(item => (
              <li key={item.id} className="flex min-w-0 items-baseline justify-between gap-3 text-body-sm">
                <span className="min-w-0 truncate">{item.name}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{item.count}</span>
              </li>
            ))}
          </ol>
        </Part>
      )}

      {gaps.length > 0 && (
        <Part title={t(key("lookedFor"))}>
          <p className="text-caption text-muted-foreground">{t(key("expectationHint"))}</p>
          <ul className="grid gap-2">
            {gaps.map(gap => (
              <li key={gap.id} aria-label={gap.label} {...surface("card")} className="grid gap-1.5 rounded-md border bg-card p-2.5">
                <p className="text-body-sm [overflow-wrap:anywhere]">{gap.label}</p>
                <p className="text-caption text-muted-foreground tabular-nums">{gap.detail}</p>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant={gap.state === "confirmed" ? "secondary" : "outline"} disabled={busy} aria-label={`${t(key("confirmExpectation"))}: ${gap.label}`} onClick={() => onGap(gap, "confirmed")}>{t(key("confirmExpectation"))}</Button>
                  <Button size="sm" variant={gap.state === "rejected" ? "secondary" : "ghost"} disabled={busy} aria-label={`${t(key("rejectExpectation"))}: ${gap.label}`} onClick={() => onGap(gap, "rejected")}>{t(key("rejectExpectation"))}</Button>
                  {gap.state === "confirmed" && gap.usable && <Button size="sm" disabled={busy} onClick={() => onUseGap(gap)}>{t(key("useExpectation"))}</Button>}
                </div>
              </li>
            ))}
          </ul>
        </Part>
      )}

      {news.length > 0 && (
        <Part title={t(key("layers.news"))}>
          <ul id="workspace-discovery" className="grid gap-1">
            {news.map(item => (
              <li key={`${item.kind}:${item.id}`} {...(item.kind === "area" ? { "data-discovery-area": item.id } : { "data-discovery-anchor": item.id })} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
                <span className="flex min-w-0 items-center gap-2 text-body-sm">
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-info" />
                  <span className="min-w-0 truncate">{item.name}</span>
                  <span className="sr-only">{t(key("new"))}</span>
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDiscovery(item, true)}>{t(key("place"))}</Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDiscovery(item, false)}>{t(key("dismiss"))}</Button>
                </span>
              </li>
            ))}
          </ul>
        </Part>
      )}

      {data === "ok" && (table.use.length > 0 || table.paths.length > 0 || table.friction.length > 0) && (
        <div className="border-t pt-2">
          <Button variant="ghost" size="sm" aria-expanded={tableOpen} className="-ml-2" onClick={() => setTableOpen(open => !open)}>
            <ChevronRight className={cn("h-4 w-4 transition-transform", tableOpen && "rotate-90")} />{t(key("seeTable"))}
          </Button>
          {tableOpen && <PeriodTables table={table} />}
        </div>
      )}
    </div>
  );
}

function SimpleTable({ caption, columns, rows }: { caption: string; columns: readonly [string, string]; rows: readonly { id: string; name: string; value: string }[] }) {
  return (
    <table className="w-full text-left text-body-sm">
      <caption className="pb-1 text-left text-caption font-medium text-foreground">{caption}</caption>
      <thead><tr className="text-caption text-muted-foreground"><th scope="col" className="py-1 pr-3 font-normal">{columns[0]}</th><th scope="col" className="py-1 text-right font-normal">{columns[1]}</th></tr></thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.id} className="border-t">
            <th scope="row" className="min-w-0 py-1.5 pr-3 font-normal [overflow-wrap:anywhere]">{row.name}</th>
            <td className="py-1.5 text-right tabular-nums">{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The numbers behind the layers, for reading and for screen readers: one small table per layer. */
function PeriodTables({ table }: { table: TableData }) {
  return (
    <div className="mt-2 grid gap-4">
      {table.use.length > 0 && <SimpleTable caption={t(key("accessibleMap"))} columns={[t(key("tableBlock")), t(key("tableClicks"))]} rows={table.use.map(row => ({ id: row.id, name: row.name, value: t(key("clicksSeen"), { count: row.clicks, seen: row.seen }) }))} />}
      {table.paths.length > 0 && <SimpleTable caption={t(key("tablePaths"))} columns={[t(key("tablePath")), t(key("tableTimes"))]} rows={table.paths.map(row => ({ id: row.id, name: `${row.from} → ${row.to}`, value: String(row.count) }))} />}
      {table.friction.length > 0 && <SimpleTable caption={t(key("tableFriction"))} columns={[t(key("tableBlock")), t(key("tableWhat"))]} rows={table.friction.map(row => ({ id: row.id, name: row.name, value: row.detail }))} />}
    </div>
  );
}
