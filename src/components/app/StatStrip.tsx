import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";
import type { FlowControlAttributes } from "@/lib/workspace/instrumentation";
import { Meter } from "@/components/app/Meter";

export type StatItem = {
  label: string;
  value: string;
  /** Beside the value: a delta, "of 8 h", a small meter. */
  extra?: React.ReactNode;
  /** Said on hover and to assistive tech: how the figure is made. */
  hint?: string;
  tone?: "danger";
  /** A figure that is also a filter (or a retry): pressed while it filters the page. */
  onClick?: () => void;
  pressed?: boolean;
  /** Counted by FlowMap where the caller says so (flowControlProps). */
  control?: FlowControlAttributes;
  /** The figure looked for first (a total): a step larger, in the theme's own colour. */
  lead?: boolean;
  /** How far the figure is towards its target (the week's hours of its goal): a thin meter under it. */
  meter?: { value: number; max: number; label: string };
};

/** Static classes (Tailwind sees whole names): as many columns as figures on a wide screen. */
const COLUMNS: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
};

/** Under lg: three to a row (two for four figures), so five figures take two short rows, not three. */
const PHONE: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2",
  5: "grid-cols-3",
  6: "grid-cols-3",
};

// A phone: tighter cells and a figure a step smaller (it still leads in the primary colour).
const PADDING = { compact: "px-3 py-2 lg:px-4", default: "px-3 py-2 lg:px-5 lg:py-3", expanded: "px-4 py-3 lg:px-6 lg:py-4" } as const;
const VALUE = { compact: "text-body font-semibold", default: "text-body font-semibold lg:text-heading", expanded: "text-heading lg:text-title" } as const;
const LEAD = { compact: "text-heading", default: "text-heading lg:text-title", expanded: "text-title lg:text-display" } as const;

/**
 * A page's figures in one row divided by hairlines (2×2 on a phone), the reference of Team time's KPIs:
 * no tiles, no count-up. The theme's warmth stays: the stat card's grainy sunset cover, now a faint wash
 * behind the whole row (texture, not a header), and the colour of the data itself (a figure's meter
 * towards its target). Figures are a description list (term, value). A figure can be a
 * filter: a toggle button laid over its whole cell. It sits on the page panel (ground), never a card of
 * its own. The variant is what a layout may choose (compact, default, expanded): padding and the
 * figure's size; the figures themselves never change.
 */
export function StatStrip({
  items,
  label,
  anchorId,
  variant = "default",
  maxColumns = 6,
  busy = false,
  className,
}: {
  items: readonly StatItem[];
  /** The strip's accessible name (a region): "Week figures". */
  label: string;
  /** The workspace block this strip is, where the page places it. */
  anchorId?: string;
  variant?: "compact" | "default" | "expanded";
  /** At most this many on a row on a wide screen (a narrow column: 2 or 3). */
  maxColumns?: number;
  /** Another period loading: its figures are not this one's yet (said, and dimmed). */
  busy?: boolean;
  className?: string;
}) {
  const shown = items.slice(0, 6);
  const columns = Math.max(1, Math.min(shown.length, maxColumns));
  return (
    <section
      aria-label={label}
      {...surface("ground")}
      data-workspace-anchor={anchorId}
      data-workspace-variant={anchorId ? variant : undefined}
      aria-busy={busy || undefined}
      className={cn("relative isolate overflow-hidden border-b transition-opacity", busy && "opacity-60", className)}
    >
      {/* The cover's sunset, faint, behind the figures: warmth without a band that reads as a line. */}
      <div aria-hidden className="cover-sunset grain pointer-events-none absolute inset-0 -z-10 opacity-15 dark:opacity-20" />
      {/* Hairlines whatever the columns: every cell draws its left and top line, and the list is pulled
          one pixel up and left so the outer ones fall outside the section (which clips). */}
      <dl className={cn("-ml-px -mt-px grid [&>*]:border-l [&>*]:border-t", PHONE[shown.length], COLUMNS[columns])}>
        {shown.map(item => (
          <Stat key={item.label} item={item} variant={variant} />
        ))}
      </dl>
    </section>
  );
}

function Stat({ item, variant }: { item: StatItem; variant: "compact" | "default" | "expanded" }) {
  return (
    <div title={item.hint} className={cn("relative grid min-w-0 content-start gap-0.5", PADDING[variant], item.pressed && "bg-primary-soft/60", item.onClick && "hover:bg-muted/40")}>
      <dt className="truncate text-caption text-muted-foreground">{item.label}</dt>
      {/* Only dt and dd in a group: the meter and the filter's button are the value's own. */}
      <dd className="grid min-w-0 gap-1.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className={cn("font-display tabular", item.lead ? LEAD[variant] : VALUE[variant], item.tone === "danger" ? "text-danger" : item.lead && "text-primary-strong")}>{item.value}</span>
          {item.extra}
        </span>
        {item.meter && (
          <Meter value={item.meter.value} max={item.meter.max} size="xs" tone={item.meter.value >= item.meter.max ? "bg-primary-strong" : "bg-primary"} label={item.meter.label} />
        )}
        {item.onClick && (
          <button
            type="button"
            aria-label={`${item.label}: ${item.value}`}
            aria-pressed={item.pressed ?? false}
            title={item.hint}
            onClick={item.onClick}
            {...item.control}
            className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        )}
      </dd>
    </div>
  );
}
