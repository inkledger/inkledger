import { isEmptySlot, slotRects, type DeskSlot, type PresetId, type SnapTarget } from "@contracts/desk";
import { t } from "@/i18n";

type Side = "left" | "right" | "top" | "bottom";
type Corner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
/** Where a pane sits on the desk: a corner, the middle of a side, or the middle. */
type Spot = Corner | Side | "center";
/** The arrangements with no big pane, told apart by how their panes stand. */
type Grid = "threeOverTwo" | "twoOverThree" | "threeColumns" | "twoColumns";
const ORDINAL = ["first", "second", "third", "fourth"] as const;

/** Where a slot sits, in the words a person uses for it. */
export type Place =
  | { kind: "whole" }
  | { kind: "half"; side: Side }
  | { kind: "column"; nth: (typeof ORDINAL)[number] }
  | { kind: "row"; nth: (typeof ORDINAL)[number] }
  | { kind: "big"; side: Side }
  | { kind: "quarter"; corner: Corner }
  /** A small one beside the big one of a "large on …" arrangement. */
  | { kind: "beside"; spot: Spot; big: Side }
  /** A pane of an arrangement of five or six with no big one. */
  | { kind: "cell"; spot: Spot; grid: Grid };

const BIG: Partial<Record<PresetId, Side>> = {
  "main-left": "left",
  "main-right": "right",
  "main-top": "top",
  "main-bottom": "bottom",
  "main-left-3": "left",
  "main-right-3": "right",
  "main-top-3": "top",
  "main-bottom-3": "bottom",
  "main-left-4": "left",
  "main-right-4": "right",
};
const GRID: Partial<Record<PresetId, Grid>> = { "top-3-bottom-2": "threeOverTwo", "top-2-bottom-3": "twoOverThree", "grid-3x2": "threeColumns", "grid-2x3": "twoColumns" };
const CORNERS: Corner[] = ["topLeft", "topRight", "bottomLeft", "bottomRight"];

/** The spot of a slot, from where its middle lies on the desk (in thirds). */
function spotOf(preset: PresetId, slot: number): Spot {
  const rect = slotRects(preset)[slot];
  if (!rect) return "center";
  const x = rect.x + rect.w / 2, y = rect.y + rect.h / 2;
  const across = x < 0.4 ? "Left" : x > 0.6 ? "Right" : "";
  const down = y < 0.4 ? "top" : y > 0.6 ? "bottom" : "";
  if (down && across) return `${down}${across}`;
  if (down) return down;
  return across === "Left" ? "left" : across === "Right" ? "right" : "center";
}

/** Where slot `slot` of an arrangement sits. */
export function placeOf(preset: PresetId, slot: number): Place {
  if (preset === "cols-2") return { kind: "half", side: slot === 0 ? "left" : "right" };
  if (preset === "rows-2") return { kind: "half", side: slot === 0 ? "top" : "bottom" };
  if (preset === "cols-3" || preset === "cols-4") return { kind: "column", nth: ORDINAL[slot] ?? "first" };
  if (preset === "rows-3" || preset === "rows-4") return { kind: "row", nth: ORDINAL[slot] ?? "first" };
  if (preset === "quad") return { kind: "quarter", corner: CORNERS[slot] ?? "topLeft" };
  const grid = GRID[preset];
  if (grid) return { kind: "cell", spot: spotOf(preset, slot), grid };
  const big = BIG[preset];
  if (!big) return { kind: "whole" };
  return slot === 0 ? { kind: "big", side: big } : { kind: "beside", spot: spotOf(preset, slot), big };
}

const isCorner = (spot: Spot): spot is Corner => (CORNERS as string[]).includes(spot);
/** A spot in words: "top right corner", "middle left". */
const spotName = (spot: Spot) => (isCorner(spot) ? t(`pages.desk.snap.corner.${spot}`) : t(`pages.desk.snap.spot.${spot}`));

/** A place said in full: unique among the places for one pane count ("top right corner, with the big one on the left"). */
export function placeName(place: Place): string {
  switch (place.kind) {
    case "whole":
      return t("pages.desk.snap.whole");
    case "half":
      return t(`pages.desk.snap.half.${place.side}`);
    case "column":
      return t(`pages.desk.snap.column.${place.nth}`);
    case "row":
      return t(`pages.desk.snap.row.${place.nth}`);
    case "big":
      return t(`pages.desk.snap.big.${place.side}`);
    case "quarter":
      return t(`pages.desk.snap.corner.${place.corner}`);
    case "beside":
      return t(`pages.desk.snap.beside.${place.big}`, { corner: spotName(place.spot) });
    case "cell":
      return t(`pages.desk.snap.cell.${place.grid}`, { spot: spotName(place.spot) });
  }
}

/** A place said short, under its arrangement's name (a menu's group): the spot alone for a small one. */
export function placeShortName(place: Place): string {
  return place.kind === "beside" || place.kind === "cell" ? spotName(place.spot) : placeName(place);
}

/** Where a target sends a pane, in words; `keys` are the panes' keys (a swap names the other one). */
export function targetName(target: SnapTarget, keys: readonly string[]): string {
  return target.kind === "swap" ? t("pages.desk.snap.swap", { key: keys[target.index] ?? "" }) : placeName(placeOf(target.preset, target.slot));
}

/** The desk's slots as the snap names say them: each issue's key, "empty slot" for one kept free. */
export const slotNames = (panes: readonly DeskSlot[]): string[] => panes.map(pane => (isEmptySlot(pane) ? t("pages.desk.slot.name") : pane.key));
