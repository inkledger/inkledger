import { describe, expect, it, vi } from "vitest";
import { createNoise3, freshSeed, mulberry32 } from "./rng";

describe("mulberry32", () => {
  it("repeats the same sequence for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const sequence = Array.from({ length: 100 }, a);
    expect(Array.from({ length: 100 }, b)).toEqual(sequence);
    expect(sequence.every(value => value >= 0 && value < 1)).toBe(true);
  });

  it("normalizes seeds to unsigned 32-bit integers", () => {
    const a = mulberry32(-1);
    const b = mulberry32(0xffffffff);
    expect(Array.from({ length: 10 }, a)).toEqual(Array.from({ length: 10 }, b));
  });

  it("produces different sequences for different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(Array.from({ length: 10 }, a)).not.toEqual(Array.from({ length: 10 }, b));
  });
});

describe("freshSeed", () => {
  it("returns an unsigned 32-bit integer", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    expect(freshSeed()).toBe(0xc0000000);
    vi.restoreAllMocks();
  });
});

describe("createNoise3", () => {
  it("is deterministic for a seeded generator", () => {
    const a = createNoise3(mulberry32(123));
    const b = createNoise3(mulberry32(123));
    const points = Array.from({ length: 50 }, (_, i) => [i / 10, i / 7, i / 5] as const);
    expect(points.map(point => a(...point))).toEqual(points.map(point => b(...point)));
  });

  it("stays finite and within the scene contract", () => {
    const noise = createNoise3(mulberry32(123));
    for (let x = -10; x <= 10; x++) {
      for (let y = -10; y <= 10; y++) {
        const value = noise(x / 3, y / 3, (x + y) / 5);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(-1);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });
});
