import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contrast, type Rgb } from "@/lib/theme/color";
import { DEFAULT_BASE, THEME_PRESETS, derivePalette, parseTriplet, type ThemeLook } from "@/lib/theme/derive";

// The sunset wash behind a page's figures: in dark it is a pastel dusk, a mid tone, so its opacity
// decides whether the muted captions and figures on it still read at AA.
const source = readFileSync(new URL("./StatStrip.tsx", import.meta.url), "utf8");
const opacityOf = (re: RegExp) => Number(re.exec(source)?.[1]) / 100;
const over = (top: Rgb, bottom: Rgb, a: number): Rgb => ({ r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a) });

describe("StatStrip's sunset wash", () => {
  it("keeps the figures and captions at AA in normal-contrast dark, every base", () => {
    const alpha = opacityOf(/cover-sunset[^"]*\bdark:opacity-(\d+)/);
    expect(alpha).toBeGreaterThan(0);
    const looks: ThemeLook[] = [
      { variant: "standard", contrast: "normal" },
      { variant: "soft", contrast: "normal" },
    ];
    const failures: string[] = [];
    for (const look of looks) {
      for (const hex of [DEFAULT_BASE, ...THEME_PRESETS.map(p => p.hex), "#808080", "#2F6DB5", "#1E9C9C"]) {
        const v = derivePalette(hex, look).dark;
        for (const ground of ["--canvas", "--card"]) {
          for (const stop of [1, 2, 3, 4, 5]) {
            const bg = over(parseTriplet(v[`--sunset-${stop}`]), parseTriplet(v[ground]), alpha);
            for (const fg of ["--muted-foreground", "--foreground", "--primary-strong"]) {
              const ratio = contrast(parseTriplet(v[fg]), bg);
              if (ratio < 4.5) failures.push(`${hex} ${look.variant} ${fg} on sunset-${stop} over ${ground}: ${ratio.toFixed(2)}`);
            }
          }
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  it("high contrast keeps its approved wash", () => {
    expect(opacityOf(/\[\.dark\[data-contrast=high\]_&\]:opacity-(\d+)/)).toBe(0.2);
  });
});
