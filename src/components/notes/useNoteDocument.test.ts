import { describe, expect, it } from "vitest";
import { newerServerCopy } from "./useNoteDocument";

describe("a note's copy read from the server", () => {
  it("replaces the editor's only when newer than the revision it builds on", () => {
    expect(newerServerCopy(false, 6, 5)).toBe(true);
    expect(newerServerCopy(false, 5, 5)).toBe(false);
    // A read that started before the last save landed.
    expect(newerServerCopy(false, 4, 5)).toBe(false);
  });

  it("never while a save is on its way", () => {
    expect(newerServerCopy(true, 9, 5)).toBe(false);
  });
});
