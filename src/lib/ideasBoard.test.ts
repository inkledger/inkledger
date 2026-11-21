import { describe, expect, it } from "vitest";
import { endOfColumn } from "./ideasBoard";

describe("moving an idea to a column's end", () => {
  it("goes after the last card, whatever gaps deletes left", () => {
    expect(endOfColumn([{ position: 0 }, { position: 4 }, { position: 9 }])).toBe(10);
  });

  it("an empty column starts at 0", () => {
    expect(endOfColumn([])).toBe(0);
  });
});
