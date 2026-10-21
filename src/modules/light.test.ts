import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { OFF, between, glides, ownLayer, poseOf, softnessOf } from "./light";
import type { Ambient } from "./types";

const light = (x: number, y = 0.8, strength = 1.2): Ambient => ({ x, y, strength, from: 0, tint: [255, 255, 255], veil: 0 });

describe("the Dashboard's light as depth", () => {
  it("leans shadows away from the light, darker the stronger it is", () => {
    const p = poseOf(light(0.6));
    expect(p.dx).toBeGreaterThan(0);
    expect(poseOf(light(-0.6)).dx).toBe(-p.dx);
    expect(poseOf(light(0, 0.8, 1.6)).a).toBe(1);
    expect(poseOf(light(0, 0.8, 0.4)).a).toBeLessThan(0.5);
  });

  it("leaves a minute's drift be and glides a real change", () => {
    const now = poseOf(light(0.5));
    // The sun a minute later: a hundredth of a unit of lean.
    expect(glides(now, poseOf(light(0.51)))).toBe(false);
    // Back on the tab hours later, or the light switched on.
    expect(glides(now, poseOf(light(-0.4)))).toBe(true);
    expect(glides(OFF, now)).toBe(true);
  });

  it("eases from one pose to the next, with no jump at either end", () => {
    const a = poseOf(light(-0.5)), b = poseOf(light(0.5));
    expect(between(a, b, 0)).toEqual(a);
    expect(between(a, b, 1)).toEqual(b);
    expect(between(a, b, 2)).toEqual(b);
    // Slow at the ends, fastest in the middle.
    const step = (t: number) => between(a, b, t + 0.01).dx - between(a, b, t).dx;
    expect(step(0)).toBeLessThan(step(0.5) / 10);
  });
});

describe("the night on the Dashboard", () => {
  it("softens the shadows with a low light and with the dark, at most ×1.6", () => {
    const noon = { x: 0, y: 1, strength: 1, from: 0, tint: [255, 255, 255] as [number, number, number], veil: 0 };
    expect(softnessOf(noon)).toBe(1);
    expect(softnessOf({ ...noon, x: 2, y: 1.2 })).toBeGreaterThan(1.3);
    expect(softnessOf({ ...noon, dim: 1 })).toBeCloseTo(1.6);
    expect(softnessOf({ ...noon, x: 9, y: 9, dim: 1 })).toBeCloseTo(1.6);
  });

  it("keeps body text at 7:1 under the deepest night, in both themes", () => {
    const css = readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf8");
    const block = (sel: RegExp) => css.slice(css.search(sel), css.indexOf("}", css.search(sel)));
    const token = (b: string, name: string) => {
      const m = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(b);
      if (!m) throw new Error(`no --${name}`);
      return hslToRgb(+m[1], +m[2] / 100, +m[3] / 100);
    };
    const light = block(/:root\s*\{/);
    const dark = block(/\.dark\s*\{/);
    const moon = token(light, "night-moon");
    const alpha = (sel: RegExp) => Number(/\/\s*([\d.]+)\)/.exec(block(sel))![1]);
    for (const [b, a] of [
      [light, alpha(/\.dashboard-night\s*\{/)],
      [dark, alpha(/\.dark \.dashboard-night\s*\{/)],
    ] as const) {
      const under = (c: number[]) => c.map((v, i) => v * (1 - a + a * moon[i]));
      expect(contrast(under(token(b, "foreground")), under(token(b, "card")))).toBeGreaterThanOrEqual(7);
    }
  });
});

function hslToRgb(h: number, s: number, l: number): number[] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map(n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)));
}
function contrast(a: number[], b: number[]) {
  const lum = (c: number[]) => {
    const [r, g, bl] = c.map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe("a surface that paints its own layer", () => {
  const plain = { transform: "none", filter: "none", backdropFilter: "none", isolation: "auto", opacity: "1", zIndex: "auto", willChange: "auto", contain: "none", mixBlendMode: "normal" };
  it("keeps a box-shadow: a solid shadow behind it would be drawn over its background", () => {
    expect(ownLayer(plain)).toBe(false);
    expect(ownLayer({ ...plain, transform: "matrix(1, 0, 0, 1, 0, 0)" })).toBe(true);
    expect(ownLayer({ ...plain, opacity: "0.9" })).toBe(true);
    expect(ownLayer({ ...plain, zIndex: "1" })).toBe(true);
    expect(ownLayer({ ...plain, willChange: "transform" })).toBe(true);
  });
});
