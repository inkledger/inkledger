import { describe, expect, it } from "vitest";
import { ownData } from "./queryState";

describe("ownData", () => {
  it("only the asked key's loaded data counts, never the previous one kept meanwhile", () => {
    expect(ownData({ isSuccess: true, isPlaceholderData: false })).toBe(true);
    expect(ownData({ isSuccess: true, isPlaceholderData: true })).toBe(false);
    expect(ownData({ isSuccess: false, isPlaceholderData: false })).toBe(false);
  });
});
