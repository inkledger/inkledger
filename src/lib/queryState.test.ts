import { describe, expect, it } from "vitest";
import { ownData } from "./queryState";

describe("ownData", () => {
  it("only the asked key's loaded data counts, never the previous one kept meanwhile", () => {
    expect(ownData({ data: [], isPlaceholderData: false })).toBe(true);
    expect(ownData({ data: [], isPlaceholderData: true })).toBe(false);
    expect(ownData({ data: undefined, isPlaceholderData: false })).toBe(false);
  });

  // Holes, exports and copies went away while the data on screen was still right.
  it("a failed refetch keeps the data read before: it still counts", () => {
    const refetchFailed = { data: [], isPlaceholderData: false, isSuccess: false, isError: true };
    expect(ownData(refetchFailed)).toBe(true);
  });
});
