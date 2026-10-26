import { describe, it, expect } from "vitest";
import {
  contrast,
  oklchToRgb,
  parseHex,
  rgbToOklch,
  toHex,
  WHITE,
} from "./color";
import {
  DEFAULT_BASE,
  derivePalette,
  hslToRgb,
  MIN_CONTRAST,
  MAX_HUE_DRIFT,
  NEUTRAL_C,
  PASTEL_DECO_C,
  PASTEL_FILL_C,
  THEME_PRESETS,
} from "./derive";
import { themeCss } from "./apply";

const rgbOf = (triplet: string) => {
  const [h, s, l] = triplet.replace(/%/g, "").split(" ").map(Number);
  return hslToRgb(h, s / 100, l / 100);
};

/** Deterministic pseudo-random hex colours. */
function* randomColours(n: number) {
  let seed = 42;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    yield `#${(seed & 0xffffff).toString(16).padStart(6, "0")}`;
  }
}

const EXTREMES = [
  "#000000",
  "#FFFFFF",
  "#808080",
  "#FF0000",
  "#00FF00",
  "#0000FF",
  "#FFFF00",
  "#00FFFF",
  "#FF00FF",
];

describe("colour math", () => {
  it("round-trips hex through OKLCH", () => {
    for (const hex of ["#B5562F", "#1F6F6B", "#4F6B4A", "#123456"]) {
      expect(toHex(oklchToRgb(rgbToOklch(parseHex(hex)!)))).toBe(
        hex.toUpperCase()
      );
    }
  });

  it("computes WCAG contrast", () => {
    expect(contrast(WHITE, { r: 0, g: 0, b: 0 })).toBeCloseTo(21, 5);
    expect(contrast(parseHex("#B5562F")!, WHITE)).toBeGreaterThan(4.5);
  });
});

describe("derivePalette", () => {
  it("guarantees readable primaries and muted text for any base colour", () => {
    for (const hex of [
      ...randomColours(200),
      ...EXTREMES,
      ...THEME_PRESETS.map(p => p.hex),
    ]) {
      const { light, dark } = derivePalette(hex);
      const darkCard = rgbOf(dark["--card"]);
      const ok = MIN_CONTRAST - 0.05;
      const pairs: [string, string, string][] = [
        // ink on pastel fills (buttons, selected states)
        ["light ink", light["--primary-foreground"], light["--primary"]],
        ["dark ink", dark["--primary-foreground"], dark["--primary"]],
        // accented text on cards
        ["light strong", light["--primary-strong"], light["--card"]],
        ["dark strong", dark["--primary-strong"], dark["--card"]],
        // active nav / badges: accented text on its soft fill
        ["light strong on soft", light["--primary-strong"], light["--primary-soft"]],
        ["dark strong on soft", dark["--primary-strong"], dark["--primary-soft"]],
        // muted text on every neutral surface
        ["light muted on canvas", light["--muted-foreground"], light["--canvas"]],
        ["light muted on muted", light["--muted-foreground"], light["--muted"]],
        ["light muted on accent", light["--muted-foreground"], light["--accent"]],
        ["dark muted on accent", dark["--muted-foreground"], dark["--accent"]],
        ["dark muted on muted", dark["--muted-foreground"], dark["--muted"]],
        // primary action (tonal ink) and its label
        ["light action", light["--action-foreground"], light["--action"]],
        ["dark action", dark["--action-foreground"], dark["--action"]],
      ];
      for (const [what, fg, bg] of pairs) {
        expect(
          contrast(rgbOf(fg), rgbOf(bg)),
          `${hex} ${what}`
        ).toBeGreaterThanOrEqual(ok);
      }
      expect(
        contrast(rgbOf(light["--muted-foreground"]), WHITE)
      ).toBeGreaterThanOrEqual(MIN_CONTRAST - 0.05);
      expect(
        contrast(rgbOf(dark["--muted-foreground"]), darkCard)
      ).toBeGreaterThanOrEqual(MIN_CONTRAST - 0.05);
      for (const v of [...Object.values(light), ...Object.values(dark)]) {
        expect(v).toMatch(/^\d+(\.\d)? \d+(\.\d)?% \d+(\.\d)?%$/);
      }
    }
  });

  it("is deterministic and follows the base hue", () => {
    expect(derivePalette("#1F6F6B")).toEqual(derivePalette("#1f6f6b"));
    const teal = rgbToOklch(
      rgbOf(derivePalette("#1F6F6B").light["--primary-strong"])
    ).h;
    expect(Math.abs(teal - rgbToOklch(parseHex("#1F6F6B")!).h)).toBeLessThan(3);
  });

  it("stays pastel: fills and decorations never exceed the chroma caps", () => {
    const chroma = (t: string) => rgbToOklch(rgbOf(t)).c;
    for (const hex of [...randomColours(100), ...EXTREMES]) {
      const { light, dark } = derivePalette(hex);
      for (const vars of [light, dark]) {
        expect(chroma(vars["--primary"]), `${hex} fill`).toBeLessThanOrEqual(
          PASTEL_FILL_C + 0.012
        );
        for (const [k, v] of Object.entries(vars)) {
          if (
            k.startsWith("--cover-") ||
            k.startsWith("--sunset-") ||
            k.startsWith("--chart-") ||
            k.startsWith("--project-")
          ) {
            expect(chroma(v), `${hex} ${k}`).toBeLessThanOrEqual(
              PASTEL_DECO_C + 0.012
            );
          }
        }
      }
    }
  });

  it("stays tone-on-tone: no derived hue drifts away from the base (no pink/lilac)", () => {
    const drift = (a: number, b: number) =>
      Math.abs(((a - b + 540) % 360) - 180);
    for (const hex of [
      ...THEME_PRESETS.map(p => p.hex),
      ...randomColours(60),
    ]) {
      const base = rgbToOklch(parseHex(hex)!);
      if (base.c < 0.04) continue; // near-greys have no meaningful hue
      const { light, dark } = derivePalette(hex);
      for (const vars of [light, dark]) {
        for (const [k, v] of Object.entries(vars)) {
          const col = rgbToOklch(rgbOf(v));
          if (col.c < 0.03) continue; // hue of near-neutral greys is noise
          expect(drift(col.h, base.h), `${hex} ${k}`).toBeLessThanOrEqual(
            MAX_HUE_DRIFT + 4
          );
        }
      }
    }
  });

  it("keeps near-grey bases neutral instead of an olive tint", () => {
    const chroma = (t: string) => rgbToOklch(rgbOf(t)).c;
    // Triplets are rounded to 0.1, which alone adds a little chroma.
    const noise = 0.006;
    const greys = ["#808080", "#000000", "#FFFFFF", "#7F8082", "#2B2B2B"];
    for (const hex of greys) {
      const baseC = rgbToOklch(parseHex(hex)!).c;
      expect(baseC, hex).toBeLessThan(NEUTRAL_C);
      const { light, dark } = derivePalette(hex);
      for (const vars of [light, dark]) {
        for (const [k, v] of Object.entries(vars)) {
          expect(chroma(v), `${hex} ${k}`).toBeLessThanOrEqual(baseC + noise);
        }
      }
    }
  });

  it("still lifts weak but coloured bases to a visible accent", () => {
    // Just above the neutral cutoff: primary keeps a real tint.
    const { light } = derivePalette("#8A7F70");
    expect(rgbToOklch(parseHex("#8A7F70")!).c).toBeGreaterThanOrEqual(
      NEUTRAL_C
    );
    expect(rgbToOklch(rgbOf(light["--primary"])).c).toBeGreaterThan(0.04);
  });

  it("falls back to the default for invalid input", () => {
    expect(derivePalette("nope").light["--primary"]).toBe(
      derivePalette(DEFAULT_BASE).light["--primary"]
    );
  });

  it("emits CSS that outranks the static tokens", () => {
    const css = themeCss("#4F6B4A");
    expect(css.startsWith("html:root{")).toBe(true);
    expect(css).toContain("html.dark{");
    expect(css).toContain("--cover-5-bg:");
  });
});

describe("static fallback tokens", () => {
  it("index.css defaults equal the derived default palette (no flash on first load)", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(
      new URL("../../index.css", import.meta.url),
      "utf8"
    );
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      return css.slice(start, css.indexOf("\n  }\n", start));
    };
    const p = derivePalette(DEFAULT_BASE);
    for (const [sel, vars] of [
      [":root", p.light],
      [".dark", p.dark],
    ] as const) {
      const text = block(sel);
      for (const [k, v] of Object.entries(vars)) {
        expect(text, `${sel} ${k}`).toContain(`${k}: ${v};`);
      }
    }
  });
  it("the focus ring stands out at 3:1 on cards, the canvas and popovers, in every preset and extreme, light and dark", () => {
    const surfaces = ["--card", "--canvas", "--popover", "--background"];
    for (const base of [...THEME_PRESETS.map(p => p.hex), ...EXTREMES, DEFAULT_BASE]) {
      const pal = derivePalette(base);
      for (const mode of ["light", "dark"] as const) {
        const ring = rgbOf(pal[mode]["--ring"]);
        for (const sfc of surfaces) {
          if (!pal[mode][sfc]) continue;
          const bg = rgbOf(pal[mode][sfc]);
          expect(contrast(ring, bg), `${base} ${mode} ring on ${sfc}`).toBeGreaterThanOrEqual(3);
          // The ring at 40% (what the app used): mixed into the surface, it fell under 3:1.
          const mixed = { r: ring.r * 0.4 + bg.r * 0.6, g: ring.g * 0.4 + bg.g * 0.6, b: ring.b * 0.4 + bg.b * 0.6 };
          if (base === DEFAULT_BASE && mode === "light" && sfc === "--card") expect(contrast(mixed, bg)).toBeLessThan(3);
        }
      }
    }
  });
});
