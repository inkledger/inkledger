import { isEmptySlot, type DeskSlot, type PresetId, type SnapTarget } from "@contracts/desk";
import { t } from "@/i18n";

type Side = "left" | "right" | "top" | "bottom";
type Corner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
const ORDINAL = ["first", "second", "third", "fourth"] as const;

/** Where a slot sits, in the words a person uses for it. */
export type Place =
  | { kind: "whole" }
  | { kind: "half"; side: Side }
  | { kind: "column"; nth: (typeof ORDINAL)[number] }
  | { kind: "big"; side: Side }
  | { kind: "quarter"; corner: Corner }
  /** A small one beside the big one of a "large on …" arrangement. */
  | { kind: "beside"; corner: Corner; big: Side };

const BIG: Partial<Record<PresetId, { side: Side; corners: [Corner, Corner] }>> = {
  "main-left": { side: "left", corners: ["topRight", "bottomRight"] },
  "main-right": { side: "right", corners: ["topLeft", "bottomLeft"] },
  "main-top": { side: "top", corners: ["bottomLeft", "bottomRight"] },
  "main-bottom": { side: "bottom", corners: ["topLeft", "topRight"] },
};
const CORNERS: Corner[] = ["topLeft", "topRight", "bottomLeft", "bottomRight"];

/** Where slot `slot` of an arrangement sits. */
export function placeOf(preset: PresetId, slot: number): Place {
  if (preset === "cols-2") return { kind: "half", side: slot === 0 ? "left" : "right" };
  if (preset === "rows-2") return { kind: "half", side: slot === 0 ? "top" : "bottom" };
  if (preset === "cols-3" || preset === "cols-4") return { kind: "column", nth: ORDINAL[slot] ?? "first" };
  if (preset === "quad") return { kind: "quarter", corner: CORNERS[slot] ?? "topLeft" };
  const big = BIG[preset];
  if (!big) return { kind: "whole" };
  return slot === 0 ? { kind: "big", side: big.side } : { kind: "beside", corner: big.corners[slot - 1] ?? big.corners[0], big: big.side };
}

/** A place said in full: unique among the places for one pane count ("top right corner, with the big one on the left"). */
export function placeName(place: Place): string {
  switch (place.kind) {
    case "whole":
      return t("pages.desk.snap.whole");
    case "half":
      return t(`pages.desk.snap.half.${place.side}`);
    case "column":
      return t(`pages.desk.snap.column.${place.nth}`);
    case "big":
      return t(`pages.desk.snap.big.${place.side}`);
    case "quarter":
      return t(`pages.desk.snap.corner.${place.corner}`);
    case "beside":
      return t(`pages.desk.snap.beside.${place.big}`, { corner: t(`pages.desk.snap.corner.${place.corner}`) });
  }
}

/** A place said short, under its arrangement's name (a menu's group): the corner alone for a small one. */
export function placeShortName(place: Place): string {
  return place.kind === "beside" ? t(`pages.desk.snap.corner.${place.corner}`) : placeName(place);
}

/** Where a target sends a pane, in words; `keys` are the panes' keys (a swap names the other one). */
export function targetName(target: SnapTarget, keys: readonly string[]): string {
  return target.kind === "swap" ? t("pages.desk.snap.swap", { key: keys[target.index] ?? "" }) : placeName(placeOf(target.preset, target.slot));
}

/** The desk's slots as the snap names say them: each issue's key, "empty slot" for one kept free. */
export const slotNames = (panes: readonly DeskSlot[]): string[] => panes.map(pane => (isEmptySlot(pane) ? t("pages.desk.slot.name") : pane.key));
