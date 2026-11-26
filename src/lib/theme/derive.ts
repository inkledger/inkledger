import { t } from "@contracts/i18n";
import {
  contrast,
  oklchToRgb,
  parseHex,
  rgbToOklch,
  toHslTriplet,
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

/** Settings → Appearance: the surfaces' family (soft: low-glare, Solarized-inspired). */
export type ThemeVariant = "standard" | "soft";
/** Settings → Appearance: the contrast level, orthogonal to light/dark and to the variant. */
export type ThemeContrast = "normal" | "high";
export type ThemeLook = { variant: ThemeVariant; contrast: ThemeContrast };
export const STANDARD_LOOK: ThemeLook = { variant: "standard", contrast: "normal" };

/** Minimum contrast for text-bearing tokens (AA + margin). */
export const MIN_CONTRAST = 4.6;

const MIN_CHROMA = 0.06;
/** Below this OKLCH chroma a base reads as grey: its hue is just noise. */
export const NEUTRAL_C = 0.02;
const MAX_CHROMA = 0.17;
/** Pastel caps: fills (buttons, bars, selections) and accented text. */
export const PASTEL_FILL_C = 0.075;
const PASTEL_TEXT_C = 0.06;
/** Max hue distance (degrees) of any derived colour from the base hue. */
export const MAX_HUE_DRIFT = 12;
/** Ceiling for any decorative colour (charts, covers). */
export const PASTEL_DECO_C = 0.085;
const wrap = (h: number) => ((h % 360) + 360) % 360;

/**
 * What each contrast level guarantees, on every surface text sits on (checked by derive.test.ts
 * for every base colour, scheme and variant). `ui` is for non-text marks: the focus ring and
 * field borders, and in high contrast hairlines and data bars too.
 */
export const CONTRAST_TARGETS: Record<ThemeContrast, { text: number; muted: number; ui: number }> = {
  normal: { text: MIN_CONTRAST, muted: MIN_CONTRAST, ui: 3.1 },
  // AAA: text 7:1; muted text is promised 4.5:1 and delivered above 7:1 (clearly firmer than
  // standard, and axe's enhanced check passes too); every mark 3:1.
  high: { text: 7.1, muted: 8.5, ui: 3.1 },
};
/**
 * The soft variant's surfaces: parchment (light) and warm umber charcoal (dark), leaning ≤ 12°
 * towards the base. The umber sits by the default base's warm neutrals, so a dark soft ground
 * never turns blue, whatever the base.
 */
export const SOFT_PAPER_H = 82;
export const SOFT_UMBER_H = 55;
/** Under the hue rule's noise floor (0.03): a surface tint, never an accent. */
export const SOFT_SURFACE_C = 0.026;
/** Dark soft: a quieter tint still (a dark ground shows chroma more than parchment does). */
export const SOFT_UMBER_C = 0.012;

const tri = (c: Oklch) => toHslTriplet(oklchToRgb({ ...c, h: wrap(c.h) }));

/**
 * The tones of a chart split by issue type (docs/design-system.md §3.5): `--chart-focus` is the first,
 * `--chart-tone-2..5` are lightness steps of the same hue and chroma. The steps sit on a grid of
 * `CHART_TONE_STEP_L` from chart-focus: away from the ground first (in light it's pale, so the others are
 * deeper), towards it when the band runs out, skipping a step that would land on "Other"
 * (`--chart-other`, the neutral). Stack order: neighbours two or more steps apart; any two at least one.
 */
export const CHART_TONE_TOKENS = [2, 3, 4, 5].map(i => `--chart-tone-${i}`);
/** One step: series that touch in a stack (any two, when a type has no hours that day) differ by this much. */
export const CHART_TONE_STEP_L = 0.08;
/** Never near-black (heavy) nor near-white (glare). */
export const CHART_TONE_BAND = [0.3, 0.9] as const;
/** A tone closer than this in lightness to "Other" would pass for it. */
const OTHER_GAP_L = 0.06;
/** The stack order of five tones sorted by lightness, by chart-focus's place among them (first in each). */
const TONE_ORDERS = [
  [0, 3, 1, 4, 2],
  [1, 3, 0, 4, 2],
  [2, 0, 3, 1, 4],
  [3, 1, 4, 0, 2],
  [4, 1, 3, 0, 2],
] as const;

/** The four tones after chart-focus, from its colour and Other's. */
function chartTones(focusTriplet: string, otherTriplet: string, dark: boolean): ThemeVars {
  const focus = rgbToOklch(parseTriplet(focusTriplet));
  const otherL = rgbToOklch(parseTriplet(otherTriplet)).l;
  const away = dark ? 1 : -1;
  const [lo, hi] = CHART_TONE_BAND;
  const inBand = (l: number) => l >= lo - 1e-9 && l <= hi + 1e-9;
  const grid = [1, 2, 3, 4, 5, 6, 7, 8].map(n => focus.l + away * n * CHART_TONE_STEP_L).filter(inBand);
  const back = [1, 2, 3, 4, 5, 6, 7, 8].map(n => focus.l - away * n * CHART_TONE_STEP_L).filter(inBand);
  const others = [...grid, ...back].filter(l => Math.abs(l - otherL) >= OTHER_GAP_L).slice(0, 4);
  const ls = [focus.l, ...others].sort((a, b) => a - b);
  const order = TONE_ORDERS[ls.indexOf(focus.l)];
  const vars: ThemeVars = {};
  order.slice(1).forEach((k, i) => {
    vars[CHART_TONE_TOKENS[i]] = tri({ ...focus, l: ls[k] ?? focus.l });
  });
  return vars;
}

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
export function derivePalette(baseHex: string, look: ThemeLook = STANDARD_LOOK): Palette {
  const plain = look.variant === "standard" && look.contrast === "normal";
  const standard = deriveStandard(baseHex);
  if (plain) return standard;
  return deriveLook(baseHex, standard, look);
}

function deriveStandard(baseHex: string): Palette {
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
  const deco = decoFor(h);

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

  // ---- covers: six grainy pastel variants + a dawn band (coverArt) ----
  // Dark covers and band are a pastel dusk (about −0.24 L), read with a dark ink as in light.
  // At −0.24 no single ink reaches AA on every stop (a dark one tops out near 3.7:1 on the
  // deepest, a pale one near 2.7:1 on the palest), so the ink is chosen first and the art fits
  // it: only the deepest stops are lifted, and the band keeps its order by being remapped,
  // never darkened (darker, the dusk turns muddy brown).
  const art = coverArt(h, deco);
  const band = (cols: Oklch[]) => cols.map(col => oklchToRgb({ ...col, c: limit(col.c) }));
  const darkTitleC = textC * 0.6;
  const darkInkC = 0.03;
  const coverDusk = duskFor(art.covers.map(([, col]) => col), 0.7, { l: DUSK_INK_L, c: limit(darkInkC), h }, limit);
  const sunsetDusk = duskFor(art.sunset.map(([, col]) => col), 0.75, { l: DUSK_INK_L, c: limit(darkTitleC), h }, limit);
  art.covers.forEach(([name, col], i) => {
    light[name] = tone(col);
    dark[name] = tone(coverDusk[i]);
  });
  art.sunset.forEach(([name, col], i) => {
    light[name] = tone(col);
    dark[name] = tone(sunsetDusk[i]);
  });
  const titleOn = (cols: Oklch[], dark: boolean, chroma: number) =>
    tone({ l: solveAgainst(h, limit(chroma), band(cols), CONTRAST_TARGETS.normal.text, dark ? 0.24 : 0.3, 0), c: chroma, h });
  light["--cover-title"] = titleOn(art.sunset.map(([, col]) => col), false, textC * 0.8);
  light["--cover-ink"] = titleOn(art.covers.map(([, col]) => col), false, 0.035);
  dark["--cover-ink"] = titleOn(coverDusk, true, darkInkC);
  dark["--cover-title"] = titleOn(sunsetDusk, true, darkTitleC);

  // ---- chart tones: lightness steps of chart-focus, for a chart split by issue type ----
  Object.assign(light, chartTones(light["--chart-focus"], light["--chart-other"], false));
  Object.assign(dark, chartTones(dark["--chart-focus"], dark["--chart-other"], true));

  return { light, dark, base: baseHex.toUpperCase() };
}


/** Decorative colours (charts, covers) are calmer on cool hues, where equal OKLCH chroma reads as louder, "screen-blue" saturation. */
const decoFor = (h: number) => {
  const cool = h > 170 && h < 300;
  return (chroma: number) => Math.min(PASTEL_DECO_C, cool ? chroma * 0.72 : chroma);
};

/**
 * The covers' light stops (six grainy pastel variants) and the pastel "dawn" band (reference sunset,
 * softened). Tone-on-tone: every stop stays within MAX_HUE_DRIFT of the base hue; variety comes from
 * lightness and chroma, never from a hue jump (big jumps turn warm bases pink/lilac).
 */
function coverArt(h: number, deco: (chroma: number) => number): { covers: [string, Oklch][]; sunset: [string, Oklch][] } {
  const offsets: [number, number, number][] = [
    [-6, 8, 4],
    [8, -4, 10],
    [0, 10, -6],
    [-8, 4, 12],
    [6, -8, 0],
    [10, 2, -10],
  ];
  const covers = offsets.flatMap(([a, b, d], i): [string, Oklch][] => [
    [`--cover-${i}-a`, { l: 0.8 + (i % 3) * 0.03, c: deco(0.075), h: h + a }],
    [`--cover-${i}-b`, { l: 0.86, c: deco(0.06), h: h + b }],
    [`--cover-${i}-c`, { l: 0.92, c: deco(0.035), h: h + d }],
    [`--cover-${i}-bg`, { l: 0.89, c: deco(0.045), h }],
  ]);
  const sunset: [string, Oklch][] = [
    ["--sunset-1", { l: 0.76, c: deco(0.07), h: h - 4 }],
    ["--sunset-2", { l: 0.93, c: deco(0.035), h: h + 10 }],
    ["--sunset-3", { l: 0.83, c: deco(0.075), h }],
    ["--sunset-4", { l: 0.88, c: deco(0.055), h: h + 8 }],
    ["--sunset-5", { l: 0.79, c: deco(0.07), h: h - 2 }],
  ];
  return { covers, sunset };
}

/** The dark ink's lightness on the dusk covers: a deep tonal umber, not black. */
const DUSK_INK_L = 0.14;
/** The dusk's lightness shift and how much of the light stops' spread it keeps. */
const DUSK_SHIFT_L = 0.24;
const DUSK_SPREAD = 0.75;
/** What the dusk stops are solved to against the ink: AA with room for triplet rounding. */
const DUSK_TARGET = MIN_CONTRAST + 0.15;

/**
 * Dark stops for a set of light pastel ones: a dusk about DUSK_SHIFT_L deeper, in the same order,
 * light enough that `ink` reaches DUSK_TARGET on every one. Where the plain shift would leave the
 * deepest stops under that, the whole set is remapped up from the lightness the ink needs (its
 * spread kept at DUSK_SPREAD), so tones never merge and nothing gets darker than the shift.
 */
function duskFor(cols: Oklch[], chromaK: number, ink: Oklch, limit: (chroma: number) => number): Oklch[] {
  const inkRgb = oklchToRgb(ink);
  const night = cols.map(col => ({ ...col, c: col.c * chromaK }));
  const lowest = Math.min(...cols.map(col => col.l));
  // The lightness at which each stop, at its own hue and chroma, reaches the target against the ink.
  const need = night.map(col => {
    const ok = (l: number) => contrast(inkRgb, oklchToRgb({ ...col, l, c: limit(col.c) })) >= DUSK_TARGET;
    let a = 0;
    let b = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (a + b) / 2;
      if (ok(mid)) b = mid;
      else a = mid;
    }
    return b;
  });
  const shifted = night.map(col => col.l - DUSK_SHIFT_L);
  if (shifted.every((l, i) => l >= need[i])) return night.map((col, i) => ({ ...col, l: shifted[i] }));
  const from = Math.max(...night.map((col, i) => need[i] - (col.l - lowest) * DUSK_SPREAD));
  return night.map(col => ({ ...col, l: Math.min(0.95, Math.max(col.l - DUSK_SHIFT_L, from + (col.l - lowest) * DUSK_SPREAD)) }));
}

/** Lightness at which (h, c) reaches `ratio` against every one of `bgs` (searching from `from` towards `towards`). */
function solveAgainst(h: number, c: number, bgs: Rgb[], ratio: number, from: number, towards: number): number {
  const ok = (l: number) => bgs.every(bg => contrast(oklchToRgb({ l, c, h }), bg) >= ratio);
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

/** A surface hue: `anchor`, leaning at most MAX_HUE_DRIFT towards the base hue (none for a grey base). */
function lean(anchor: number, h: number | null): number {
  if (h === null) return anchor;
  const d = ((h - anchor + 540) % 360) - 180;
  return wrap(anchor + Math.max(-MAX_HUE_DRIFT, Math.min(MAX_HUE_DRIFT, d)));
}

/** State colours: fixed hues (they carry meaning, so they are never pulled to the base). */
export const STATUS_TOKENS = [
  "--danger",
  "--danger-soft",
  "--destructive",
  "--destructive-foreground",
  "--success",
  "--success-soft",
  "--warning",
  "--warning-soft",
  "--info",
  "--info-soft",
] as const;
const STATUS_HUES = { danger: 27, success: 150, warning: 75, info: 250 } as const;

/** Data marks that must stand out of a card in high contrast, and by how much. */
const DATA_TOKENS: [string, number][] = [
  ["--chart-focus", 4.6],
  ["--chart-other", 3.6],
  ["--chart-break", 3.1],
  ...[1, 2, 3, 4, 5, 6].map((i): [string, number] => [`--project-${i}`, 3.1]),
];

type Surfaces = { canvas: Oklch; card: Oklch; popover: Oklch; muted: Oklch; accent: Oklch };

/**
 * The soft and high-contrast palettes: the standard one's decorations (covers, sunset, shadows),
 * new surfaces, and every text and mark solved against all the surfaces it may sit on.
 */
function deriveLook(baseHex: string, standard: Palette, look: ThemeLook): Palette {
  const base = rgbToOklch(parseHex(baseHex) ?? parseHex(DEFAULT_BASE)!);
  const h = base.h;
  const neutral = base.c < NEUTRAL_C;
  const limit = (chroma: number) => (neutral ? Math.min(chroma, base.c) : chroma);
  const c = neutral ? base.c : Math.min(MAX_CHROMA, Math.max(MIN_CHROMA, base.c));
  const fillC = Math.min(c, PASTEL_FILL_C);
  const textC = Math.min(c, PASTEL_TEXT_C);
  const high = look.contrast === "high";
  const soft = look.variant === "soft";
  const target = CONTRAST_TARGETS[look.contrast];

  const scheme = (dark: boolean, from: ThemeVars): ThemeVars => {
    // Soft surfaces are parchment or umber charcoal (a tint under the hue rule's floor); standard ones keep the base hue.
    const sh = soft ? lean(dark ? SOFT_UMBER_H : SOFT_PAPER_H, neutral ? null : h) : h;
    const S = dark ? SOFT_UMBER_C : SOFT_SURFACE_C;
    const surf = (l: number, chroma: number): Oklch => (soft ? { l, c: chroma, h: sh } : { l, c: limit(chroma), h });
    const pick = (std: number, sf: number) => (soft ? sf : std);
    const [canvasL, cardL, popoverL, mutedL, accentL] = dark
      ? high
        ? [pick(0.1, 0.15), pick(0.14, 0.19), pick(0.17, 0.215), pick(0.18, 0.225), pick(0.22, 0.26)]
        : [0.215, 0.255, 0.275, 0.285, 0.305]
      : high
        ? [pick(0.975, 0.95), pick(1, 0.985), pick(1, 0.99), pick(0.965, 0.96), pick(0.935, 0.935)]
        : [0.94, 0.975, 0.982, 0.952, 0.93];
    const sc = high ? S * 0.7 : S;
    const s: Surfaces = {
      canvas: surf(canvasL, soft ? sc : 0.003),
      card: surf(cardL, soft ? sc * (dark ? 1 : 0.7) : dark ? 0.004 : 0),
      popover: surf(popoverL, soft ? sc * (dark ? 0.9 : 0.55) : dark ? 0.005 : 0),
      muted: surf(mutedL, soft ? sc * 0.9 : 0.0025),
      accent: surf(accentL, soft ? sc : 0.005),
    };
    const primarySoft: Oklch = { l: accentL + (dark ? 0.005 : -0.005), c: limit(Math.min(c * (dark ? 0.35 : 0.25), dark ? 0.035 : 0.03)), h };
    const rgb = (col: Oklch) => oklchToRgb({ ...col, h: wrap(col.h) });
    const textOn = [s.canvas, s.card, s.popover, s.muted, s.accent, primarySoft].map(rgb);
    const neutralsOnly = [s.canvas, s.card, s.popover, s.muted, s.accent].map(rgb);
    const solve = (hue: number, chroma: number, bgs: Rgb[], ratio: number, fromL: number) =>
      solveAgainst(hue, chroma, bgs, ratio, fromL, dark ? 1 : 0);
    const T = (col: Oklch) => tri({ ...col, c: limit(col.c) });
    const Surf = (col: Oklch) => tri(col);

    // Text: body text well above the target (soft is calmer than standard, high is near black/white).
    const inkC = soft ? 0.016 : 0.004;
    const fgL = solve(sh, limit(inkC), textOn, high ? 13 : 9, dark ? (high ? 0.95 : 0.88) : high ? 0.16 : 0.32);
    const fg = Surf({ l: fgL, c: limit(inkC), h: sh });
    const mutedFgL = solve(sh, limit(0.012), textOn, target.muted, dark ? 0.66 : 0.52);
    const strongL = solve(h, limit(textC), textOn, target.text, dark ? 0.72 : 0.52);
    // Marks: hairlines are only decoration in normal contrast; field borders always reach the UI target.
    const borderL = high ? solve(sh, limit(0.008), neutralsOnly, target.ui, dark ? 0.45 : 0.62) : dark ? 0.35 : 0.89;
    const inputL = solve(sh, limit(soft ? S * 0.8 : 0.008), neutralsOnly, high ? 4.6 : target.ui, dark ? 0.42 : 0.72);
    // The fill carries its own ink (pastel in both schemes); the ink reaches the text target on it.
    const fill: Oklch = dark ? { l: high ? 0.78 : 0.72, c: Math.min(c, PASTEL_FILL_C * 0.85), h } : { l: 0.82, c: fillC, h };
    const inkL = solveAgainst(h, limit(dark ? textC * 0.8 : textC), [rgb({ ...fill, c: limit(fill.c) })], target.text, dark ? 0.3 : 0.34, 0);
    // Primary action: tonal ink on light, pale on dark, its label solved against it.
    const actionC = Math.min(c, dark ? 0.035 : 0.045);
    const label: Oklch = dark ? { l: 0.2, c: 0.01, h } : { l: 0.985, c: soft ? 0.008 : 0.005, h: sh };
    const actionL = dark
      ? solveAgainst(h, limit(actionC), [rgb({ ...label, c: limit(label.c) })], target.text, high ? 0.92 : 0.88, 1)
      : solveAgainst(h, limit(actionC), [rgb({ ...label, c: limit(label.c) })], target.text, 0.34, 0);

    const vars: ThemeVars = {
      "--canvas": Surf(s.canvas),
      "--background": Surf(s.card),
      "--card": Surf(s.card),
      "--popover": Surf(s.popover),
      "--foreground": fg,
      "--card-foreground": fg,
      "--popover-foreground": fg,
      "--muted": Surf(s.muted),
      "--secondary": Surf(s.muted),
      "--secondary-foreground": fg,
      "--muted-foreground": Surf({ l: mutedFgL, c: limit(0.012), h: sh }),
      "--accent": Surf(s.accent),
      "--accent-foreground": fg,
      "--border": Surf({ l: borderL, c: limit(soft ? S * 0.8 : 0.008), h: sh }),
      "--input": Surf({ l: inputL, c: limit(soft ? S * 0.8 : 0.008), h: sh }),
      "--primary": T(fill),
      "--primary-foreground": T({ l: inkL, c: dark ? textC * 0.8 : textC, h }),
      "--primary-strong": T({ l: strongL, c: textC, h }),
      "--primary-soft": T(primarySoft),
      "--ring": T({ l: strongL, c: textC, h }),
      "--action": T({ l: actionL, c: actionC, h }),
      "--action-foreground": T(label),
      "--chart-ink": fg,
    };
    if (high) {
      // Data marks stand out of the card at 3:1 or more, keeping their hue and chroma.
      const onCard = [s.card, s.canvas, s.muted].map(rgb);
      for (const [name, ratio] of DATA_TOKENS) {
        const was = rgbToOklch(parseTriplet(from[name]));
        vars[name] = tri({ l: solveAgainst(was.h, was.c, onCard, ratio, was.l, dark ? 1 : 0), c: was.c, h: was.h });
      }
      // The cover title reaches AAA on every stop of the band. In dark, high contrast keeps its own
      // night (the user-approved look, pinned by high-contrast.snapshot.json): the light stops 0.42
      // deeper, then a step deeper still, with a pale title — not the normal looks' pastel dusk.
      const art = coverArt(h, decoFor(h));
      const deep = (col: Oklch, chromaK: number): Oklch => {
        const was = rgbToOklch(parseTriplet(T({ ...col, l: col.l - 0.42, c: col.c * chromaK })));
        return { ...was, l: was.l - 0.1 };
      };
      const stops = dark ? art.sunset.map(([, col]) => deep(col, 0.75)) : [1, 2, 3, 4, 5].map(i => rgbToOklch(parseTriplet(from[`--sunset-${i}`])));
      if (dark) stops.forEach((col, i) => (vars[`--sunset-${i + 1}`] = T(col)));
      const titleC = dark ? textC * 0.3 : textC * 0.6;
      vars["--cover-title"] = T({ l: solveAgainst(h, limit(titleC), stops.map(rgb), target.text, dark ? 0.97 : 0.2, dark ? 1 : 0), c: titleC, h });
      // The covers' ink (banner initials) likewise reaches AAA on every cover stop.
      const coverNames = [0, 1, 2, 3, 4, 5].flatMap(i => ["a", "b", "c", "bg"].map(s => `--cover-${i}-${s}`));
      const tiles = dark ? art.covers.map(([, col]) => deep(col, 0.7)) : coverNames.map(name => rgbToOklch(parseTriplet(from[name])));
      if (dark) tiles.forEach((col, i) => (vars[coverNames[i]] = T(col)));
      const inkC = dark ? 0.03 : 0.035;
      vars["--cover-ink"] = T({ l: solveAgainst(h, limit(inkC), tiles.map(rgb), target.text, dark ? 0.97 : 0.2, dark ? 1 : 0), c: inkC, h });
    }
    // The chart tones follow this look's chart-focus (in high contrast, solved to 3:1 above).
    Object.assign(vars, chartTones(vars["--chart-focus"] ?? from["--chart-focus"], vars["--chart-other"] ?? from["--chart-other"], dark));
    // State colours: text on its soft fill and on every surface, at this level's target.
    for (const [name, hue] of Object.entries(STATUS_HUES)) {
      const fillCol: Oklch = dark ? { l: high ? 0.22 : 0.3, c: 0.04, h: hue } : { l: high ? 0.955 : 0.93, c: 0.035, h: hue };
      const textChroma = name === "warning" ? 0.09 : 0.08;
      const l = solveAgainst(hue, textChroma, [...textOn, rgb(fillCol)], target.text, dark ? 0.74 : 0.5, dark ? 1 : 0);
      vars[`--${name}-soft`] = tri(fillCol);
      vars[`--${name}`] = tri({ l, c: textChroma, h: hue });
    }
    const white = { r: 1, g: 1, b: 1 };
    vars["--destructive"] = tri({ l: solveAgainst(STATUS_HUES.danger, 0.12, [white], target.text, 0.52, 0), c: 0.12, h: STATUS_HUES.danger });
    vars["--destructive-foreground"] = tri({ l: 1, c: 0, h: 0 });
    return vars;
  };

  return {
    light: { ...standard.light, ...scheme(false, standard.light) },
    dark: { ...standard.dark, ...scheme(true, standard.dark) },
    base: standard.base,
  };
}

/** "h s% l%" → sRGB. */
export function parseTriplet(t: string): Rgb {
  const [hh, ss, ll] = t.replace(/%/g, "").split(" ").map(Number);
  return hslToRgb(hh, ss / 100, ll / 100);
}

/** Contrast of accented text (primary-strong) on cards, for the picker badge. */
export function primaryContrast(baseHex: string, look: ThemeLook = STANDARD_LOOK): {
  light: number;
  dark: number;
} {
  const p = derivePalette(baseHex, look);
  return {
    light: contrast(parseTriplet(p.light["--primary-strong"]), parseTriplet(p.light["--card"])),
    dark: contrast(parseTriplet(p.dark["--primary-strong"]), parseTriplet(p.dark["--card"])),
  };
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4) };
}
