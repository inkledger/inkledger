import type { PresetId } from "@contracts/desk";
import { t } from "@/i18n";

const starts = (shares: readonly number[]) => shares.map((_, i) => shares.slice(0, i).reduce((sum, share) => sum + share, 0));

/** The grid's columns or rows as CSS, from their shares. */
export const template = (shares: readonly number[]) => shares.map(share => `minmax(0,${share.toFixed(4)}fr)`).join(" ");

/**
 * Where the lines of the desk lie, as CSS variables on the grid (--desk-x0… and
 * --desk-y0…, from 0 to 1): the dividers are placed by them, so a drag that rewrites
 * them moves every divider with no redraw.
 */
export function lineVars(cols: readonly number[], rows: readonly number[]): Record<string, string> {
  const vars: Record<string, string> = {};
  [...starts(cols), 1].forEach((x, i) => (vars[`--desk-x${i}`] = x.toFixed(4)));
  [...starts(rows), 1].forEach((y, i) => (vars[`--desk-y${i}`] = y.toFixed(4)));
  return vars;
}

/** Where the line after track `index` lies (0 to 1). */
export const lineAt = (shares: readonly number[], index: number) => starts(shares)[index] + shares[index];

const LABEL_KEY = {
  single: "single",
  "cols-2": "cols2",
  "rows-2": "rows2",
  "cols-3": "cols3",
  "cols-4": "cols4",
  "main-left": "mainLeft",
  "main-right": "mainRight",
  "main-top": "mainTop",
  "main-bottom": "mainBottom",
  quad: "quad",
  "rows-3": "rows3",
  "rows-4": "rows4",
  "main-left-3": "mainLeft3",
  "main-right-3": "mainRight3",
  "main-top-3": "mainTop3",
  "main-bottom-3": "mainBottom3",
  "main-left-4": "mainLeft4",
  "main-right-4": "mainRight4",
  "top-3-bottom-2": "top3Bottom2",
  "top-2-bottom-3": "top2Bottom3",
  "grid-3x2": "grid3x2",
  "grid-2x3": "grid2x3",
} as const satisfies Record<PresetId, string>;

/** An arrangement's name, in the user's words. */
export const layoutLabel = (id: PresetId) => t(`pages.desk.layouts.${LABEL_KEY[id]}`);
