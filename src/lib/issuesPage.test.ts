import { describe, expect, it } from "vitest";
import { inViewCount, keyboardRows } from "./issuesPage";

describe("the Issues page's rows", () => {
  const favourites = ["F1", "F2", "F3", "F4", "F5", "F6"];

  it("j / k walk only the favourites drawn, then the list", () => {
    const rows = keyboardRows({ pinnedMode: true, showMain: true, page: 1, pinned: favourites, allPinned: false, issues: ["A", "B"] });
    expect(rows).toEqual(["F1", "F2", "F3", "F4", "F5", "A", "B"]);
    expect(keyboardRows({ pinnedMode: true, showMain: true, page: 1, pinned: favourites, allPinned: true, issues: [] })).toEqual(favourites);
    // Past the first page the favourites aren't drawn.
    expect(keyboardRows({ pinnedMode: true, showMain: true, page: 2, pinned: favourites, allPinned: true, issues: ["A"] })).toEqual(["A"]);
  });

  it("counts the main list only while it is drawn", () => {
    // "Favourites only" in pinned mode hides the list, whose query still answers.
    expect(inViewCount({ pinnedMode: true, showMain: false, total: 40, pinned: 6 })).toBe(6);
    expect(inViewCount({ pinnedMode: true, showMain: true, total: 40, pinned: 6 })).toBe(46);
    expect(inViewCount({ pinnedMode: false, showMain: true, total: 40, pinned: 6 })).toBe(40);
  });
});
