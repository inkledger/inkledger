import { describe, expect, it } from "vitest";
import { nextIndex } from "./roving";

describe("arrow keys in a row of choices", () => {
  it("move one step and wrap at both ends", () => {
    expect(nextIndex(0, 3, { key: "ArrowRight" })).toBe(1);
    expect(nextIndex(2, 3, { key: "ArrowRight" })).toBe(0);
    expect(nextIndex(0, 3, { key: "ArrowLeft" })).toBe(2);
    expect(nextIndex(1, 3, { key: "ArrowUp" })).toBe(0);
    expect(nextIndex(1, 3, { key: "ArrowDown" })).toBe(2);
  });

  it("jump to the ends with Home and End", () => {
    expect(nextIndex(1, 4, { key: "Home" })).toBe(0);
    expect(nextIndex(1, 4, { key: "End" })).toBe(3);
  });

  it("start from the first choice when none is chosen", () => {
    expect(nextIndex(-1, 3, { key: "ArrowRight" })).toBe(1);
    expect(nextIndex(7, 3, { key: "ArrowLeft" })).toBe(2);
  });

  it("leave modified keys and other keys to whoever owns them", () => {
    expect(nextIndex(0, 3, { key: "ArrowRight", altKey: true })).toBeNull();
    expect(nextIndex(0, 3, { key: "ArrowRight", altKey: true, shiftKey: true })).toBeNull();
    expect(nextIndex(0, 3, { key: "ArrowLeft", metaKey: true })).toBeNull();
    expect(nextIndex(0, 3, { key: "ArrowLeft", ctrlKey: true })).toBeNull();
    expect(nextIndex(0, 3, { key: "Enter" })).toBeNull();
    expect(nextIndex(0, 0, { key: "ArrowRight" })).toBeNull();
  });
});
