import { describe, it, expect } from "vitest";
import {
  contrast,
  deltaE,
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
  CONTRAST_TARGETS,
  STATUS_TOKENS,
  DATA_PALETTE_TOKENS,
  DATA_EDGE_TOKENS,
  DATA_MARK_TOKENS,
  DATA_NEUTRAL_TOKENS,
  DATA_SERIES,
  DATA_STYLE,
  type ThemeLook,
} from "./derive";

/** Series colours tell series apart: they are exempt from the tone-on-tone and neutral rules (their own tests below). */
const isData = (k: string) => [...DATA_PALETTE_TOKENS, ...DATA_EDGE_TOKENS, ...DATA_MARK_TOKENS, ...DATA_NEUTRAL_TOKENS].includes(k);
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
          if (isData(k)) continue;
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
          if (isData(k)) continue;
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
    expect(css).toContain('html[data-contrast="high"]:root{');
    expect(css.indexOf('html.dark[data-contrast="high"]{')).toBeGreaterThan(css.indexOf('html[data-contrast="high"]:root{'));
    expect(themeCss("#4F6B4A", "soft")).not.toBe(css);
  });
});

const LOOKS: ThemeLook[] = [
  { variant: "standard", contrast: "normal" },
  { variant: "soft", contrast: "normal" },
  { variant: "standard", contrast: "high" },
  { variant: "soft", contrast: "high" },
];
const lookName = (l: ThemeLook) => `${l.variant}/${l.contrast}`;

describe("contrast matrix: every base colour × scheme × variant × contrast", () => {
  const SURFACES = ["--canvas", "--card", "--popover", "--muted", "--accent"];
  const bases = [...randomColours(200), ...EXTREMES, ...THEME_PRESETS.map(p => p.hex)];
  for (const look of LOOKS.filter(l => !(l.variant === "standard" && l.contrast === "normal"))) {
    it(`${lookName(look)} meets its targets`, () => {
      const target = CONTRAST_TARGETS[look.contrast];
      const failures: string[] = [];
      for (const hex of bases) {
        const pal = derivePalette(hex, look);
        for (const mode of ["light", "dark"] as const) {
          const v = pal[mode];
          const check = (what: string, fg: string, bg: string, min: number) => {
            // The targets carry a margin over AA/AAA; triplets rounded to 0.1 may eat 0.05 of it.
            const ratio = contrast(rgbOf(v[fg]), rgbOf(v[bg]));
            if (ratio < min - 0.05) failures.push(`${hex} ${mode} ${what}: ${fg} on ${bg} ${ratio.toFixed(2)} < ${min}`);
          };
          for (const bg of [...SURFACES, "--primary-soft"]) {
            check("body text", "--foreground", bg, target.text);
            check("accented text", "--primary-strong", bg, target.text);
            check("muted text", "--muted-foreground", bg, target.muted);
            check("focus ring", "--ring", bg, target.ui);
            for (const s of ["danger", "success", "warning", "info"]) check("state text", `--${s}`, bg, target.text);
          }
          for (const s of ["danger", "success", "warning", "info"]) check("state on its fill", `--${s}`, `--${s}-soft`, target.text);
          check("ink on fill", "--primary-foreground", "--primary", target.text);
          check("action label", "--action-foreground", "--action", target.text);
          check("destructive label", "--destructive-foreground", "--destructive", target.text);
          for (const bg of SURFACES) check("field border", "--input", bg, target.ui);
          if (look.contrast === "high") {
            for (const bg of SURFACES) check("hairline", "--border", bg, target.ui);
            for (const d of ["--chart-focus", "--chart-other", "--chart-break", ...[1, 2, 3, 4, 5, 6].map(i => `--project-${i}`)]) {
              for (const bg of ["--card", "--canvas", "--muted"]) check("data mark", d, bg, 3);
            }
          }
          for (const x of Object.values(v)) if (!/^\d+(\.\d)? \d+(\.\d)?% \d+(\.\d)?%$/.test(x)) failures.push(`${hex} ${mode} bad triplet ${x}`);
        }
      }
      expect(failures.slice(0, 20)).toEqual([]);
    });
  }

  it("the cover title reads on every stop of the sunset band, in every look", () => {
    // The sign-in cover, the install header and the brand mark draw --cover-title on the band.
    const failures: string[] = [];
    for (const look of LOOKS) {
      const target = CONTRAST_TARGETS[look.contrast].text;
      for (const hex of bases) {
        const pal = derivePalette(hex, look);
        for (const mode of ["light", "dark"] as const) {
          const v = pal[mode];
          for (const stop of [1, 2, 3, 4, 5].map(i => `--sunset-${i}`)) {
            const ratio = contrast(rgbOf(v["--cover-title"]), rgbOf(v[stop]));
            if (ratio < target - 0.05) failures.push(`${hex} ${lookName(look)} ${mode} ${stop} ${ratio.toFixed(2)} < ${target}`);
          }
        }
      }
    }
    expect(failures.slice(0, 20)).toEqual([]);
  });

  it("the covers' ink (banner initials) reads on every cover stop, in every look", () => {
    const failures: string[] = [];
    const stops = [0, 1, 2, 3, 4, 5].flatMap(i => ["a", "b", "c", "bg"].map(s => `--cover-${i}-${s}`));
    for (const look of LOOKS) {
      const target = CONTRAST_TARGETS[look.contrast].text;
      for (const hex of bases) {
        const pal = derivePalette(hex, look);
        for (const mode of ["light", "dark"] as const) {
          const v = pal[mode];
          for (const stop of stops) {
            const ratio = contrast(rgbOf(v["--cover-ink"]), rgbOf(v[stop]));
            if (ratio < target - 0.05) failures.push(`${hex} ${lookName(look)} ${mode} ${stop} ${ratio.toFixed(2)} < ${target}`);
          }
        }
      }
    }
    expect(failures.slice(0, 20)).toEqual([]);
  });

  it("high contrast promises AAA, soft never falls under AA", () => {
    // With the 0.05 the matrix allows for rounding, each target still lands on or over the promise.
    expect(CONTRAST_TARGETS.high.text - 0.05).toBeGreaterThanOrEqual(7);
    expect(CONTRAST_TARGETS.high.muted - 0.05).toBeGreaterThanOrEqual(7);
    expect(CONTRAST_TARGETS.high.ui - 0.05).toBeGreaterThanOrEqual(3);
    expect(CONTRAST_TARGETS.normal.text - 0.05).toBeGreaterThanOrEqual(4.5);
    expect(CONTRAST_TARGETS.normal.ui - 0.05).toBeGreaterThanOrEqual(3);
  });

  it("every look stays tone-on-tone and pastel (state colours keep their own hues)", () => {
    const drift = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
    const chroma = (t: string) => rgbToOklch(rgbOf(t)).c;
    const status = new Set<string>(STATUS_TOKENS);
    for (const hex of [...THEME_PRESETS.map(p => p.hex), ...randomColours(40)]) {
      const base = rgbToOklch(parseHex(hex)!);
      for (const look of LOOKS) {
        const pal = derivePalette(hex, look);
        for (const vars of [pal.light, pal.dark]) {
          expect(chroma(vars["--primary"]), `${hex} ${lookName(look)} fill`).toBeLessThanOrEqual(PASTEL_FILL_C + 0.012);
          if (base.c < 0.04) continue;
          for (const [k, v] of Object.entries(vars)) {
            if (status.has(k) || isData(k)) continue;
            const col = rgbToOklch(rgbOf(v));
            if (col.c < 0.03) continue;
            expect(drift(col.h, base.h), `${hex} ${lookName(look)} ${k}`).toBeLessThanOrEqual(MAX_HUE_DRIFT + 4);
          }
        }
      }
    }
  });

  it("soft surfaces are parchment in light and blue slate in dark", () => {
    const { light, dark } = derivePalette("#808080", { variant: "soft", contrast: "normal" });
    const card = (t: string) => rgbToOklch(rgbOf(t));
    expect(card(light["--card"]).h).toBeGreaterThan(60);
    expect(card(light["--card"]).h).toBeLessThan(100);
    expect(card(dark["--card"]).h).toBeGreaterThan(210);
    expect(card(dark["--card"]).h).toBeLessThan(260);
  });
});

describe("data palette: one family around the base colour, told apart by lightness (every base × look × scheme)", () => {
  const bases = [...THEME_PRESETS.map(p => p.hex), ...EXTREMES, ...randomColours(40)];
  const CVDS = ["protan", "deutan", "tritan"] as const;
  const GROUNDS = ["--card", "--canvas", "--muted"];
  /**
   * OKLab ×100. 6 under each colour blindness (the dataviz floor, legal with the secondary cues every chart
   * has: a text legend, separators, textures in high contrast), between any two of the first five series
   * and between series one or two slots apart (a period without the types between them puts them side by
   * side); 10 for normal vision between series one or two slots apart.
   */
  const MIN_CVD_DE = 6;
  /** Series six to eight beside their neighbours: the same floor less the bands' room (textures help). */
  const MIN_CVD_DE_LATE = 5;
  const MIN_NORMAL_DE = 9.5;
  const series = (vars: Record<string, string>) => DATA_PALETTE_TOKENS.map(k => rgbOf(vars[k]));
  const styleOf = (look: ThemeLook) => DATA_STYLE[look.contrast === "high" ? "high" : look.variant === "soft" ? "soft" : "standard"];
  const drift = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

  for (const look of LOOKS) {
    it(`${lookName(look)}: muted chroma, alternating lightness, apart under colour blindness, 3:1 by fill or outline`, () => {
      const failures: string[] = [];
      const style = styleOf(look);
      const min = style.contrast;
      for (const hex of bases) {
        const pal = derivePalette(hex, look);
        for (const mode of ["light", "dark"] as const) {
          const v = pal[mode];
          const cols = series(v);
          const ok = cols.map(c => rgbToOklch(c));
          const at = (what: string) => `${hex} ${mode} ${what}`;
          // Chroma: never above the look's (triplets rounded to 0.1 may add a little).
          ok.forEach((o, i) => o.c > style.c + 0.004 && failures.push(at(`data-${i + 1} chroma ${o.c.toFixed(3)}`)));
          // The band: never near-black in light (heavy), never near-white in dark (glare).
          ok.forEach((o, i) => {
            if (mode === "light" && o.l < 0.42 - 0.005) failures.push(at(`data-${i + 1} L ${o.l.toFixed(3)} under 0.42`));
            if (mode === "dark" && (o.l < 0.45 - 0.005 || o.l > 0.82 + 0.005)) failures.push(at(`data-${i + 1} L ${o.l.toFixed(3)} outside 0.45..0.82`));
          });
          // Lightness: neighbours ≥ 0.08 apart, alternating lighter and darker.
          for (let i = 1; i < ok.length; i++) {
            const dl = ok[i].l - ok[i - 1].l;
            if (Math.abs(dl) < 0.08) failures.push(at(`data-${i}/${i + 1} ΔL ${dl.toFixed(3)}`));
            if (i >= 2 && Math.sign(dl) === Math.sign(ok[i - 1].l - ok[i - 2].l)) failures.push(at(`data-${i + 1} does not alternate`));
          }
          // Colour blindness: any two of the first five, and series one or two slots apart.
          const pairs: [number, number][] = [];
          for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) pairs.push([i, j]);
          for (let i = 5; i < cols.length; i++) pairs.push([i - 2, i], [i - 1, i]);
          for (const [i, j] of pairs) {
            for (const cvd of CVDS) {
              const d = deltaE(cols[i], cols[j], cvd);
              if (d < (j >= 5 ? MIN_CVD_DE_LATE : MIN_CVD_DE)) failures.push(at(`${cvd} data-${i + 1}/${j + 1} ΔE ${d.toFixed(1)}`));
            }
          }
          for (let i = 1; i < cols.length; i++) {
            for (const j of [i - 1, i - 2].filter(j => j >= 0)) {
              const d = deltaE(cols[j], cols[i]);
              if (d < MIN_NORMAL_DE) failures.push(at(`normal data-${j + 1}/${i + 1} ΔE ${d.toFixed(1)}`));
            }
          }
          // WCAG 1.4.11: a series reaches the contrast on every ground by its fill or by its 1px outline;
          // the base series and every series further from the ground than it reach it by fill alone.
          const ground = rgbToOklch(rgbOf(v["--card"])).l;
          cols.forEach((col, i) => {
            const edge = rgbOf(v[DATA_EDGE_TOKENS[i]]);
            const fillOk = GROUNDS.every(bg => contrast(col, rgbOf(v[bg])) >= min - 0.05);
            const edgeOk = GROUNDS.every(bg => contrast(edge, rgbOf(v[bg])) >= min - 0.05);
            if (!edgeOk) failures.push(at(`data-${i + 1} outline under ${min}`));
            if (fillOk && v[DATA_EDGE_TOKENS[i]] !== v[DATA_PALETTE_TOKENS[i]]) failures.push(at(`data-${i + 1} needs no outline`));
            const further = Math.abs(ok[i].l - ground) >= Math.abs(ok[0].l - ground) - 0.005;
            if (further && !fillOk) failures.push(at(`data-${i + 1} fill under ${min}`));
            // The texture's ink stands out on its series.
            const mark = contrast(rgbOf(v[DATA_MARK_TOKENS[i]]), col);
            if (mark < 2.5) failures.push(at(`data-${i + 1} texture ink ${mark.toFixed(2)}`));
          });
          // The neutrals never pass for a series: "No type" (common) as far as two series are, "Other"
          // (past the eighth, always on top of the stack, named in the legend) at least 4 apart.
          for (const [name, cvdMin, normalMin] of [["--data-none", MIN_CVD_DE, MIN_NORMAL_DE], ["--data-other", 4, 6]] as const) {
            const n = rgbOf(v[name]);
            cols.forEach((col, i) => {
              const cvd = Math.min(...CVDS.map(x => deltaE(n, col, x)));
              const normal = deltaE(n, col);
              if (cvd < cvdMin || normal < normalMin) failures.push(at(`${name} vs data-${i + 1} ΔE ${cvd.toFixed(1)}/${normal.toFixed(1)}`));
            });
            const edge = rgbOf(v[name.replace("--data-", "--data-edge-")]);
            if (!GROUNDS.every(bg => contrast(edge, rgbOf(v[bg])) >= min - 0.05)) failures.push(at(`${name} outline under ${min}`));
          }
        }
      }
      expect(failures.slice(0, 20)).toEqual([]);
    });
  }

  it("stays in the warm, muted family: the default reads terracotta, light sand, dark olive, dusty rose, warm slate", () => {
    const cols = series(derivePalette(DEFAULT_BASE).light).map(c => rgbToOklch(c));
    const base = rgbToOklch(parseHex(DEFAULT_BASE)!).h;
    expect(drift(cols[0].h, base)).toBeLessThan(4);
    const between = (h: number, a: number, b: number) => h >= a && h <= b;
    expect(between(cols[1].h, 65, 95) && cols[1].l > cols[0].l + 0.15, "sand").toBe(true);
    expect(between(cols[2].h, 100, 140) && cols[2].l < cols[0].l - 0.15, "olive").toBe(true);
    expect(drift(cols[3].h, 12) < 20 && cols[3].l > cols[0].l, "dusty rose").toBe(true);
    expect(between(cols[4].h, 230, 275) && cols[4].c < 0.04, "warm slate").toBe(true);
    // No royal blue, purple or emerald: a cool hue is always a muted one, for every base and look.
    for (const hex of [...THEME_PRESETS.map(p => p.hex), ...EXTREMES]) {
      for (const look of LOOKS) {
        const pal = derivePalette(hex, look);
        for (const mode of ["light", "dark"] as const) {
          for (const [i, o] of series(pal[mode]).map(c => rgbToOklch(c)).entries()) {
            if (o.h > 170 && o.h < 300) expect(o.c, `${hex} ${lookName(look)} ${mode} data-${i + 1}`).toBeLessThanOrEqual(styleOf(look).c * 0.75 + 0.004);
          }
        }
      }
    }
  });

  it("follows the base colour: its hue first, the arc moving with it, never across violet from a warm base", () => {
    for (const hex of THEME_PRESETS.map(p => p.hex)) {
      const h0 = rgbToOklch(parseHex(hex)!).h;
      const cols = series(derivePalette(hex).light).map(c => rgbToOklch(c));
      expect(drift(cols[0].h, h0), hex).toBeLessThan(4);
      // The full-strength companions (sand, olive, rose, the light and deep tones) stay within 110° of the base.
      DATA_SERIES.forEach((s, i) => {
        if (s.c >= 0.5) expect(drift(cols[i].h, h0), `${hex} data-${i + 1}`).toBeLessThan(112);
      });
    }
  });

  it("calmer in soft, firmer in high contrast", () => {
    expect(DATA_STYLE.soft.c).toBeLessThan(DATA_STYLE.standard.c);
    expect(DATA_STYLE.high.c).toBeGreaterThan(DATA_STYLE.standard.c);
    expect(DATA_STYLE.standard.c).toBeLessThanOrEqual(0.1);
    const chromaOf = (look: ThemeLook) => rgbToOklch(series(derivePalette(DEFAULT_BASE, look).light)[0]).c;
    expect(chromaOf({ variant: "soft", contrast: "normal" })).toBeLessThan(chromaOf(LOOKS[0]));
    expect(chromaOf({ variant: "standard", contrast: "high" })).toBeGreaterThan(chromaOf(LOOKS[0]));
  });

  it("a series keeps its hue in light and dark and in every look (a type never changes colour family)", () => {
    for (const hex of [...THEME_PRESETS.map(p => p.hex), "#808080"]) {
      const ref = series(derivePalette(hex).light).map(c => rgbToOklch(c).h);
      for (const look of LOOKS) {
        const pal = derivePalette(hex, look);
        for (const mode of ["light", "dark"] as const) {
          series(pal[mode]).forEach((c, i) => expect(drift(rgbToOklch(c).h, ref[i]), `${hex} ${lookName(look)} ${mode} data-${i + 1}`).toBeLessThan(12));
        }
      }
    }
  });

  it("gives a grey base the default's warm family, eight colours apart, not eight greys", () => {
    for (const hex of ["#808080", "#000000", "#FFFFFF"]) {
      const cols = series(derivePalette(hex).light);
      expect(drift(rgbToOklch(cols[0]).h, 45), hex).toBeLessThan(6);
      for (const c of cols) expect(rgbToOklch(c).c, hex).toBeGreaterThan(0.025);
      for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) expect(deltaE(cols[i], cols[j]), `${hex} ${i + 1}/${j + 1}`).toBeGreaterThan(4);
    }
  });
});

describe("static fallback tokens", () => {
  it("the browser bar and the PWA splash use the default canvas (light and dark)", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    const p = derivePalette(DEFAULT_BASE);
    const light = toHex(rgbOf(p.light["--canvas"]));
    const dark = toHex(rgbOf(p.dark["--canvas"]));
    const html = read("../../../index.html");
    expect(html).toContain(`<meta name="theme-color" content="${light}" media="(prefers-color-scheme: light)" />`);
    expect(html).toContain(`<meta name="theme-color" content="${dark}" media="(prefers-color-scheme: dark)" />`);
    const manifest = JSON.parse(read("../../../public/manifest.webmanifest")) as { background_color: string; theme_color: string };
    expect([manifest.background_color, manifest.theme_color]).toEqual([light, light]);
  });

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
    const hc = derivePalette(DEFAULT_BASE, { variant: "standard", contrast: "high" });
    for (const [sel, vars] of [
      [":root", p.light],
      [".dark", p.dark],
      [':root[data-contrast="high"]', hc.light],
      ['.dark[data-contrast="high"]', hc.dark],
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
