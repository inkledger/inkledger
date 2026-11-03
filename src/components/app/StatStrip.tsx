import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";
import type { FlowControlAttributes } from "@/lib/workspace/instrumentation";

export type StatItem = {
  label: string;
  value: string;
  /** Beside the value: a delta, "of 8 h", a small meter. */
  extra?: React.ReactNode;
  /** Said on hover and to assistive tech: how the figure is made. */
  hint?: string;
  tone?: "danger";
  /** A figure that is also a filter: pressed while it filters the page. */
  onClick?: () => void;
  pressed?: boolean;
  /** Counted by FlowMap where the caller says so (flowControlProps). */
  control?: FlowControlAttributes;
};

/** Static classes (Tailwind sees whole names): as many columns as figures on a wide screen, two on a phone. */
const COLUMNS: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
};

const PADDING = { compact: "px-4 py-2", default: "px-5 py-3", expanded: "px-6 py-4" } as const;
const VALUE = { compact: "text-body font-semibold", default: "text-heading", expanded: "text-title" } as const;

/**
 * A page's figures in one row divided by hairlines (2×2 on a phone), the reference of Team time's KPIs:
 * no cover, no tiles, no count-up. A figure can be a filter (a toggle button). It sits on the page
 * panel (ground): never a card of its own. The variant is what a layout may choose (compact,
 * default, expanded): padding and the figure's size, the figures themselves never change.
 */
export function StatStrip({
  items,
  label,
  anchorId,
  variant = "default",
  className,
}: {
  items: readonly StatItem[];
  /** The strip's accessible name (a region): "Week figures". */
  label: string;
  /** The workspace block this strip is, where the page places it. */
  anchorId?: string;
  variant?: "compact" | "default" | "expanded";
  className?: string;
}) {
  const shown = items.slice(0, 6);
  return (
    <section
      aria-label={label}
      {...surface("ground")}
      data-workspace-anchor={anchorId}
      data-workspace-variant={anchorId ? variant : undefined}
      className={cn(
        "grid grid-cols-2 divide-border border-b lg:divide-x",
        COLUMNS[Math.max(1, shown.length)],
        // A phone: two per row, a hairline under the first row and between the two columns.
        "max-lg:[&>*:nth-child(2n)]:border-l max-lg:[&>*:not(:nth-last-child(-n+2))]:border-b",
        className
      )}
    >
      {shown.map(item => (
        <Stat key={item.label} item={item} variant={variant} />
      ))}
    </section>
  );
}

function Stat({ item, variant }: { item: StatItem; variant: "compact" | "default" | "expanded" }) {
  const body = (
    <>
      <span className="truncate text-caption text-muted-foreground">{item.label}</span>
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className={cn("font-display tabular", VALUE[variant], item.tone === "danger" && "text-danger")}>{item.value}</span>
        {item.extra}
      </span>
    </>
  );
  const box = cn("grid min-w-0 content-start gap-0.5 text-left", PADDING[variant]);
  return item.onClick ? (
    <button
      type="button"
      title={item.hint}
      aria-pressed={item.pressed ?? false}
      onClick={item.onClick}
      {...item.control}
      className={cn(box, "outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", item.pressed && "bg-primary-soft/60")}
    >
      {body}
    </button>
  ) : (
    <div title={item.hint} className={box}>
      {body}
    </div>
  );
}
