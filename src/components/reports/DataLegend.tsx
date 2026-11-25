import { formatDurationLong } from "@contracts/time";
import type { DataColour } from "@/lib/dataColors";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

export type LegendItem = { key: string; name: string; seconds: number; colour: DataColour };

/**
 * The series of a chart, named in text with their time and share (colour is never the only cue: in
 * high contrast each swatch also wears its series' texture). In the chart's own order, so a swatch
 * sits where its segment does.
 */
export function DataLegend({ items, label, className }: { items: LegendItem[]; label: string; className?: string }) {
  const total = items.reduce((sum, i) => sum + i.seconds, 0);
  return (
    <ul aria-label={label} className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground", className)}>
      {items.map(item => (
        <li key={item.key} className="inline-flex min-w-0 items-center gap-1.5">
          <span aria-hidden className={cn("h-3 w-3 shrink-0 rounded-sm", item.colour.fill, item.colour.texture)} />
          <span className="truncate font-medium text-foreground">{item.name}</span>
          <span className="tabular">
            {t("pages.reports.typeShare", { duration: formatDurationLong(item.seconds), share: total > 0 ? Math.round((item.seconds / total) * 100) : 0 })}
          </span>
        </li>
      ))}
    </ul>
  );
}
