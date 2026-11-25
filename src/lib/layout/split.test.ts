import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceSetting } from "@/lib/storage";
import { clampWidth, formatWidth, parseWidth, splitBounds, widthForKey, SPLIT_STEP } from "./split";

const bounds = splitBounds({ container: 1200, viewport: 1440, paneMin: 320, mainMin: 480, viewportShare: 0.6 });

describe("split", () => {
  it("keeps the main pane's minimum and the window's share", () => {
    expect(bounds).toEqual({ min: 320, max: 720 });
    // A wide container: the window's share caps it.
    expect(splitBounds({ container: 2400, viewport: 1000, paneMin: 320, mainMin: 480, viewportShare: 0.6 })).toEqual({ min: 320, max: 600 });
    // Too narrow for both: the side pane keeps its own minimum.
    expect(splitBounds({ container: 700, viewport: 1440, paneMin: 320, mainMin: 480, viewportShare: 0.6 })).toEqual({ min: 320, max: 320 });
  });

  it("clamps a dragged width", () => {
    expect(clampWidth(100, bounds)).toBe(320);
    expect(clampWidth(5000, bounds)).toBe(720);
    expect(clampWidth(400.4, bounds)).toBe(400);
  });

  it("moves with the keys, within the bounds", () => {
    expect(widthForKey("ArrowLeft", 400, bounds)).toBe(400 + SPLIT_STEP);
    expect(widthForKey("ArrowRight", 400, bounds)).toBe(400 - SPLIT_STEP);
    expect(widthForKey("ArrowLeft", 400, bounds, true)).toBe(464);
    expect(widthForKey("ArrowRight", 325, bounds)).toBe(320);
    expect(widthForKey("ArrowLeft", 715, bounds)).toBe(720);
    expect(widthForKey("Home", 500, bounds)).toBe(320);
    expect(widthForKey("End", 500, bounds)).toBe(720);
    expect(widthForKey("ArrowUp", 500, bounds)).toBeNull();
    expect(widthForKey("a", 500, bounds)).toBeNull();
  });

  it("stores a width and reads back only a valid one", () => {
    expect(parseWidth(formatWidth(431.6))).toBe(432);
    expect(formatWidth(null)).toBeNull();
    expect(parseWidth(null)).toBeNull();
    expect(parseWidth("abc")).toBeNull();
    expect(parseWidth("-4")).toBeNull();
    expect(parseWidth("0")).toBeNull();
    expect(parseWidth("1e9")).toBeNull();
    expect(parseWidth(" 400 ")).toBe(400);
  });

  describe("kept on the device", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("a width set survives a reload; the default removes it", () => {
      const data = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
      });
      const first = deviceSetting("ikl-split", parseWidth, formatWidth);
      expect(first.get()).toBeNull();
      first.set(clampWidth(512.3, bounds));
      // A reload reads it back.
      expect(deviceSetting("ikl-split", parseWidth, formatWidth).get()).toBe(512);
      first.set(null);
      expect(data.has("ikl-split")).toBe(false);
      data.set("ikl-split", "wide");
      expect(deviceSetting("ikl-split", parseWidth, formatWidth).get()).toBeNull();
    });
  });
});
