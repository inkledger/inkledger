import { DATA_SLOTS, OTHER_COLOUR, type DataColour } from "@/lib/dataColors";
import type { ProjectColor } from "@/lib/projectColors";
import type { LegendItem } from "./DataLegend";
import { t } from "@/i18n";

/**
 * An issue whose type isn't known (not in the catalogue), and the types past the palette's five.
 * A leading space: a real type is trimmed, so it can never be one of these.
 */
const NO_TYPE = " none";
const OTHER = " other";

// Literal classes: Tailwind generates only what it can read. chart-focus first, then its tones.
const FILLS = ["bg-chart-focus", "bg-chart-tone-2", "bg-chart-tone-3", "bg-chart-tone-4", "bg-chart-tone-5"] as const;

export type TypeSeries = {
  /** The series a type is drawn in: its own (the five busiest) or Other */
  keyOf: (issueType: string | undefined) => string;
  nameOf: (key: string) => string;
  colourOf: (key: string) => DataColour;
  /** For PeriodBars: the series' fill */
  barColour: (key: string) => ProjectColor;
  /** The stack's order, bottom first: the five by hours, then Other */
  order: string[];
  legend: LegendItem[];
  /** Two series or more: worth a legend and the tones */
  split: boolean;
};

/**
 * A range's issue types as chart series: the five with the most hours (ties by name) take chart-focus and
 * its four tones in that order, in the bars and the legend; every other type and "No type" are summed as
 * Other (chart-other). `split`: two series or more (one series is plain chart-focus, no legend).
 */
export function typeSeries(types: { type: string; seconds: number }[]): TypeSeries {
  const totals = new Map<string, number>();
  for (const x of types) {
    const key = x.type.trim() || NO_TYPE;
    totals.set(key, (totals.get(key) ?? 0) + x.seconds);
  }
  const ranked = [...totals.entries()]
    .filter(([key]) => key !== NO_TYPE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, DATA_SLOTS)
    .map(([key]) => key);
  const slotOf = new Map(ranked.map((key, i) => [key, i]));
  const keyOf = (issueType: string | undefined) => {
    const key = issueType?.trim() || NO_TYPE;
    return slotOf.has(key) ? key : OTHER;
  };
  const nameOf = (key: string) => (key === OTHER ? t("pages.reports.otherTypes") : key);
  const colourOf = (key: string): DataColour => {
    const i = slotOf.get(key);
    return i === undefined ? OTHER_COLOUR : { slot: i + 1, fill: FILLS[i] };
  };
  const sums = new Map<string, number>();
  for (const [key, seconds] of totals) sums.set(keyOf(key), (sums.get(keyOf(key)) ?? 0) + seconds);
  const order = [...ranked, ...(sums.has(OTHER) ? [OTHER] : [])];
  return {
    keyOf,
    nameOf,
    colourOf,
    barColour: key => {
      const c = colourOf(key);
      return { fill: c.fill, soft: c.fill, solid: c.fill, stroke: "" };
    },
    order,
    split: order.length >= 2,
    legend: order.map(key => ({ key, name: nameOf(key), seconds: sums.get(key) ?? 0, colour: colourOf(key) })),
  };
}
