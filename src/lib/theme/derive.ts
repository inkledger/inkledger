import { t } from "@contracts/i18n";
import {
  contrast,
  oklchToRgb,
  parseHex,
  rgbToOklch,
  toHslTriplet,
  WHITE,
  type Oklch,
  type Rgb,
} from "./color";

/** Default brand colour (terracotta). */
export const DEFAULT_BASE = "#B5562F";

/** Curated starting points for the colour picker (names are read when asked: they follow the language). */
export const THEME_PRESETS: { name: string; hex: string }[] = [
  {
    get name() {
      return t("ui.color.terracotta");
    },
    hex: "#B5562F",
  },
  {
    get name() {
      return t("ui.color.ochre");
    },
    hex: "#A8741A",
  },
  {
    get name() {
      return t("ui.color.sage");
    },
    hex: "#4F6B4A",
  },
  {
    get name() {
      return t("ui.color.teal");
    },
    hex: "#1F6F6B",
  },
  {
    get name() {
      return t("ui.color.ocean");
    },
    hex: "#2F5F98",
  },
  {
    get name() {
      return t("ui.color.slate");
    },
    hex: "#4A5668",
  },
  {
    get name() {
      return t("ui.color.plum");
    },
    hex: "#7A3E62",
  },
];

export type ThemeVars = Record<string, string>;
export type Palette = { light: ThemeVars; dark: ThemeVars; base: string };

/** Minimum contrast for text-bearing tokens (AA + margin). */
export const MIN_CONTRAST = 4.6;

const MIN_CHROMA = 0.06;
/** Below this OKLCH chroma a base reads as grey: its hue is just noise. */
export const NEUTRAL_C = 0.02;
const MAX_CHROMA = 0.17;
/** Pastel caps: fills (buttons, bars, selections) and accented text. */
export const PASTEL_FILL_C = 0.075;
export const PASTEL_TEXT_C = 0.06;
/** Max hue distance (degrees) of any derived colour from the base hue. */
export const MAX_HUE_DRIFT = 12;
/** Ceiling for any decorative colour (charts, covers). */
export const PASTEL_DECO_C = 0.085;
const wrap = (h: number) => ((h % 360) + 360) % 360;

const tri = (c: Oklch) => toHslTriplet(oklchToRgb({ ...c, h: wrap(c.h) }));

/**
 * Lightness (searching from `from` towards `towards`) at which colour
 * (h, c) reaches `ratio` contrast against `bg`.
 */
function solveLightness(
  h: number,
  c: number,
  bg: Rgb,
  ratio: number,
  from: number,
  towards: number
): number {
  const ok = (l: number) => contrast(oklchToRgb({ l, c, h }), bg) >= ratio;
  if (ok(from)) return from;
  let a = from;
  let b = towards;
  for (let i = 0; i < 30; i++) {
    const mid = (a + b) / 2;
    if (ok(mid)) b = mid;
    else a = mid;
  }
  return b;
}

/**
 * Derive every themable token from one base colour, in OKLCH so that
 * lightness steps look even across hues. Status colours (success/warning/
 * danger/info) are intentionally not derived: they carry meaning.
 */
export function derivePalette(baseHex: string): Palette {
  const rgb = parseHex(baseHex) ?? parseHex(DEFAULT_BASE)!;
  const base = rgbToOklch(rgb);
  const h = base.h;
  // Near-greys (#808080, black, white) give a neutral theme: no derived
  // colour gets more chroma than the base, instead of boosting a noisy hue
  // (≈90°, olive) up to MIN_CHROMA.
  const neutral = base.c < NEUTRAL_C;
  const limit = (chroma: number) =>
    neutral ? Math.min(chroma, base.c) : chroma;
  const tone = (col: Oklch) => tri({ ...col, c: limit(col.c) });
  const c = neutral
    ? base.c
    : Math.min(MAX_CHROMA, Math.max(MIN_CHROMA, base.c));
  // Decorative colours (charts, covers) are calmer on cool hues, where
  // equal OKLCH chroma reads as louder, "screen-blue" saturation.
  const cool = h > 170 && h < 300;
  const deco = (chroma: number) =>
    Math.min(PASTEL_DECO_C, cool ? chroma * 0.72 : chroma);

  // ---- light ----
  // Pastel rule: fills stay soft (low chroma, high lightness) and carry a
  // dark "ink" of the same hue; accented text uses a muted, AA-safe tone.
  const fillC = Math.min(c, PASTEL_FILL_C);
  const textC = Math.min(c, PASTEL_TEXT_C);
  const lightFill = { l: 0.82, c: fillC, h };
  const lightInkL = solveLightness(
    h,
    textC,
    oklchToRgb(lightFill),
    MIN_CONTRAST,
    0.34,
    0.12
  );
  // Text tokens are solved against the darkest surface they sit on, not just the card:
  // accented text on its soft fill (active nav, badges), muted text on hover/accent.
  const lightSoft = { l: 0.955, c: Math.min(c * 0.2, 0.025), h };
  const lightAccent = { l: 0.945, c: 0.004, h };
  const lightStrongL = solveLightness(
    h,
    textC,
    oklchToRgb({ ...lightSoft, c: limit(lightSoft.c) }),
    MIN_CONTRAST,
    0.56,
    0.2
  );
  const mutedFgL = solveLightness(
    h,
    limit(0.01),
    oklchToRgb({ ...lightAccent, c: limit(lightAccent.c) }),
    MIN_CONTRAST,
    0.56,
    0.2
  );

  const light: ThemeVars = {
    "--canvas": tone({ l: 0.962, c: 0.0025, h }),
    "--background": tone({ l: 1, c: 0, h }),
    "--card": tone({ l: 1, c: 0, h }),
    "--popover": tone({ l: 1, c: 0, h }),
    "--foreground": tone({ l: 0.2, c: 0.004, h }),
    "--card-foreground": tone({ l: 0.2, c: 0.004, h }),
    "--popover-foreground": tone({ l: 0.2, c: 0.004, h }),
    "--muted": tone({ l: 0.968, c: 0.0025, h }),
    "--secondary": tone({ l: 0.968, c: 0.0025, h }),
    "--secondary-foreground": tone({ l: 0.2, c: 0.004, h }),
    "--muted-foreground": tone({ l: mutedFgL, c: 0.01, h }),
    "--accent": tone(lightAccent),
    "--accent-foreground": tone({ l: 0.2, c: 0.004, h }),
    "--border": tone({ l: 0.935, c: 0.004, h }),
    "--input": tone({ l: 0.885, c: 0.006, h }),
    "--primary": tone(lightFill),
    "--primary-foreground": tone({ l: lightInkL, c: textC, h }),
    "--primary-strong": tone({ l: lightStrongL, c: textC, h }),
    "--primary-soft": tone(lightSoft),
    "--ring": tone({ l: lightStrongL, c: textC, h }),
    // Primary action: tonal ink (dark, desaturated base hue), not black.
    "--action": tone({ l: 0.32, c: Math.min(c, 0.045), h }),
    "--action-foreground": tone({ l: 0.98, c: 0.005, h }),
    "--chart-focus": tone({ l: 0.84, c: deco(0.08), h: h + 6 }),
    "--chart-other": tone({ l: 0.9, c: deco(0.035), h }),
    "--chart-break": tone({ l: 0.8, c: 0.014, h }),
    "--chart-ink": tone({ l: 0.2, c: 0.004, h }),
    "--cover-ink": tone({ l: 0.32, c: 0.035, h }),
    "--shadow-color": tone({ l: 0.3, c: 0.02, h }),
    "--overlay": tone({ l: 0.18, c: 0.01, h }),
  };

  // ---- dark ----
  const darkFill = { l: 0.72, c: Math.min(c, PASTEL_FILL_C * 0.85), h };
  const darkInkL = solveLightness(
    h,
    textC,
    oklchToRgb(darkFill),
    MIN_CONTRAST,
    0.3,
    0.08
  );
  // Lightest surfaces under text in dark mode (see the light ones above).
  const darkSoft = { l: 0.27, c: Math.min(c * 0.3, 0.03), h };
  const darkAccent = { l: 0.26, c: 0.006, h };
  const darkStrongL = solveLightness(
    h,
    textC,
    oklchToRgb({ ...darkSoft, c: limit(darkSoft.c) }),
    MIN_CONTRAST,
    0.72,
    0.95
  );
  const darkMutedFgL = solveLightness(
    h,
    limit(0.01),
    oklchToRgb({ ...darkAccent, c: limit(darkAccent.c) }),
    MIN_CONTRAST,
    0.66,
    0.95
  );
  const dark: ThemeVars = {
    "--canvas": tone({ l: 0.16, c: 0.004, h }),
    "--background": tone({ l: 0.2, c: 0.005, h }),
    "--card": tone({ l: 0.2, c: 0.005, h }),
    "--popover": tone({ l: 0.22, c: 0.006, h }),
    "--foreground": tone({ l: 0.95, c: 0.004, h }),
    "--card-foreground": tone({ l: 0.95, c: 0.004, h }),
    "--popover-foreground": tone({ l: 0.95, c: 0.004, h }),
    "--muted": tone({ l: 0.24, c: 0.005, h }),
    "--secondary": tone({ l: 0.24, c: 0.005, h }),
    "--secondary-foreground": tone({ l: 0.95, c: 0.004, h }),
    "--muted-foreground": tone({ l: darkMutedFgL, c: 0.01, h }),
    "--accent": tone(darkAccent),
    "--accent-foreground": tone({ l: 0.95, c: 0.004, h }),
    "--border": tone({ l: 0.27, c: 0.006, h }),
    "--input": tone({ l: 0.34, c: 0.008, h }),
    "--primary": tone(darkFill),
    "--primary-foreground": tone({ l: darkInkL, c: textC * 0.8, h }),
    "--primary-strong": tone({ l: darkStrongL, c: textC, h }),
    "--primary-soft": tone(darkSoft),
    "--ring": tone({ l: darkStrongL, c: textC, h }),
    "--action": tone({ l: 0.88, c: 0.035, h }),
    "--action-foreground": tone({ l: 0.2, c: 0.01, h }),
    "--chart-focus": tone({ l: 0.72, c: deco(0.07), h: h + 6 }),
    "--chart-other": tone({ l: 0.6, c: deco(0.035), h }),
    "--chart-break": tone({ l: 0.5, c: 0.014, h }),
    "--chart-ink": tone({ l: 0.95, c: 0.004, h }),
    "--cover-ink": tone({ l: 0.22, c: 0.03, h }),
    "--shadow-color": tone({ l: 0.05, c: 0.01, h }),
    "--overlay": tone({ l: 0.05, c: 0.005, h }),
  };

  // ---- project tones: six stable data colours (hashed per project key) ----
  // Same tone-on-tone rule as the covers: lightness and chroma vary, the hue
  // stays near the base.
  const projectTones: Oklch[] = [
    // Equally visible: no near-grey or near-white tone for a busy project.
    { l: 0.8, c: deco(0.08), h: h + 6 },
    { l: 0.87, c: deco(0.06), h: h - 8 },
    { l: 0.73, c: deco(0.055), h: h + 10 },
    { l: 0.84, c: deco(0.075), h: h - 2 },
    { l: 0.77, c: deco(0.04), h: h - 10 },
    { l: 0.88, c: deco(0.05), h: h + 12 },
  ];
  projectTones.forEach((col, i) => {
    light[`--project-${i + 1}`] = tone(col);
    dark[`--project-${i + 1}`] = tone({ ...col, l: col.l - 0.14, c: col.c * 0.85 });
  });

  // ---- covers: six grainy pastel variants + a dawn band ----
  // Tone-on-tone: every stop stays within MAX_HUE_DRIFT of the base hue;
  // variety comes from lightness and chroma, never from a hue jump
  // (big jumps turn warm bases pink/lilac).
  const offsets: [number, number, number][] = [
    [-6, 8, 4],
    [8, -4, 10],
    [0, 10, -6],
    [-8, 4, 12],
    [6, -8, 0],
    [10, 2, -10],
  ];
  offsets.forEach(([a, b, d], i) => {
    const stops: [string, Oklch][] = [
      [`--cover-${i}-a`, { l: 0.8 + (i % 3) * 0.03, c: deco(0.075), h: h + a }],
      [`--cover-${i}-b`, { l: 0.86, c: deco(0.06), h: h + b }],
      [`--cover-${i}-c`, { l: 0.92, c: deco(0.035), h: h + d }],
      [`--cover-${i}-bg`, { l: 0.89, c: deco(0.045), h }],
    ];
    for (const [name, col] of stops) {
      light[name] = tone(col);
      dark[name] = tone({ ...col, l: col.l - 0.24, c: col.c * 0.7 });
    }
  });
  // Pastel "dawn" band (reference sunset, softened): light stops, dark title ink.
  const sunset: [string, Oklch][] = [
    ["--sunset-1", { l: 0.76, c: deco(0.07), h: h - 4 }],
    ["--sunset-2", { l: 0.93, c: deco(0.035), h: h + 10 }],
    ["--sunset-3", { l: 0.83, c: deco(0.075), h }],
    ["--sunset-4", { l: 0.88, c: deco(0.055), h: h + 8 }],
    ["--sunset-5", { l: 0.79, c: deco(0.07), h: h - 2 }],
  ];
  for (const [name, col] of sunset) {
    light[name] = tone(col);
    dark[name] = tone({ ...col, l: col.l - 0.26, c: col.c * 0.75 });
  }
  light["--cover-title"] = tone({ l: 0.3, c: textC * 0.8, h });
  dark["--cover-title"] = tone({ l: 0.2, c: textC * 0.6, h });

  return { light, dark, base: baseHex.toUpperCase() };
}

/** Contrast of accented text (primary-strong) on cards, for the picker badge. */
export function primaryContrast(baseHex: string): {
  light: number;
  dark: number;
} {
  const p = derivePalette(baseHex);
  const parse = (t: string) => {
    const [hh, ss, ll] = t.replace(/%/g, "").split(" ").map(Number);
    return hslToRgb(hh, ss / 100, ll / 100);
  };
  return {
    light: contrast(parse(p.light["--primary-strong"]), WHITE),
    dark: contrast(parse(p.dark["--primary-strong"]), parse(p.dark["--card"])),
  };
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4) };
}
