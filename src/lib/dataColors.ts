import { writeStored } from "@/lib/storage";

/**
 * A chart series' colour (docs/design-system.md §3.5): a class over a chart token, so it follows a theme
 * switch at once. Issue types: `typeSeries` (chart-focus and its tones, chart-other for Other); projects:
 * `projectColor` (project-1..6), as on the Dashboard.
 */
export type DataColour = {
  /** 1..5, or 0 for "Other" */
  slot: number;
  /** Background class of the series (a bar, a segment, a legend swatch) */
  fill: string;
};

/** At most five series; the rest are summed as Other. */
export const DATA_SLOTS = 5;

/** The neutral of everything past the fifth series, and of what has no category: never a tone. */
export const OTHER_COLOUR: DataColour = { slot: 0, fill: "bg-chart-other" };

/** Signing out: drops the per-device series slots an earlier build saved (they named the account's categories). */
export function forgetDataColours(): void {
  writeStored("ikl-data-colours", null);
}
