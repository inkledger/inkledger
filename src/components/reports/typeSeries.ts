import { assignColours, NONE_COLOUR, OTHER_COLOUR, type DataColour } from "@/lib/dataColors";
import type { ProjectColor } from "@/lib/projectColors";
import type { LegendItem } from "./DataLegend";
import { t } from "@/i18n";

/**
 * An issue whose type isn't known (not in the catalogue), and the types past the palette's eight.
 * A leading space: a real type is trimmed, so it can never be one of these.
 */
const NO_TYPE = " none";
const OTHER = " other";

export type TypeSeries = {
  /** The series a type is drawn in: its own, "No type", or Other past the eighth */
  keyOf: (issueType: string | undefined) => string;
  nameOf: (key: string) => string;
  colourOf: (key: string) => DataColour;
  /** For PeriodBars: the series' fill with its high-contrast texture */
  barColour: (key: string) => ProjectColor;
  /** The stack's order, bottom first: the palette's (touching series stay apart), then the neutrals */
  order: string[];
  legend: LegendItem[];
};

/** A range's issue types (busiest first, as reports.types returns them) as chart series with stable colours. */
export function typeSeries(types: { type: string; seconds: number }[]): TypeSeries {
  const ranked = types.map(x => ({ key: x.type.trim() || NO_TYPE, seconds: x.seconds }));
  // The palette is for real types only: "No type" stays neutral and takes no slot.
  const colours = assignColours(ranked.filter(r => r.key !== NO_TYPE).map(r => r.key), "type");
  const seriesOf = (key: string) => {
    const colour = colours.get(key);
    return colour && colour.slot === 0 ? OTHER : key;
  };
  const keyOf = (issueType: string | undefined) => seriesOf(issueType?.trim() || NO_TYPE);
  const nameOf = (key: string) => (key === NO_TYPE ? t("pages.reports.noType") : key === OTHER ? t("pages.reports.otherTypes") : key);
  const colourOf = (key: string) => (key === NO_TYPE ? NONE_COLOUR : key === OTHER ? OTHER_COLOUR : (colours.get(key) ?? OTHER_COLOUR));
  // Real types in palette order, then "No type", then Other.
  const rank = (key: string) => colourOf(key).slot || (key === NO_TYPE ? 98 : 99);
  const totals = new Map<string, number>();
  for (const r of ranked) totals.set(seriesOf(r.key), (totals.get(seriesOf(r.key)) ?? 0) + r.seconds);
  const order = [...totals.keys()].sort((a, b) => rank(a) - rank(b));
  return {
    keyOf,
    nameOf,
    colourOf,
    barColour: key => {
      const c = colourOf(key);
      return { fill: `${c.fill} ${c.texture}`.trim(), soft: c.fill, solid: c.fill, stroke: "" };
    },
    order,
    legend: order.map(key => ({ key, name: nameOf(key), seconds: totals.get(key) ?? 0, colour: colourOf(key) })),
  };
}
