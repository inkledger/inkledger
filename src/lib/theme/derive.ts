import { t } from "@contracts/i18n";
import {
  contrast,
  deltaE,
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
/** The soft variant's surfaces: parchment (light) and blue slate (dark), leaning ≤ 12° towards the base. */
export const SOFT_PAPER_H = 82;
export const SOFT_SLATE_H = 236;
/** Under the hue rule's noise floor (0.03): a surface tint, never an accent. */
export const SOFT_SURFACE_C = 0.026;

const tri = (c: Oklch) => toHslTriplet(oklchToRgb({ ...c, h: wrap(c.h) }));

/** The categorical data palette: eight series colours, for charts only (docs/design-system.md §3.5). */
export const DATA_COUNT = 8;
export const DATA_PALETTE_TOKENS = Array.from({ length: DATA_COUNT }, (_, i) => `--data-${i + 1}`);
/**
 * Each series' 1px outline (WCAG 1.4.11): a series under the look's contrast on the chart's grounds
 * wears a tone of itself that reaches it; one that already reaches it wears its own colour (no visible line).
 */
export const DATA_EDGE_TOKENS = Array.from({ length: DATA_COUNT }, (_, i) => `--data-edge-${i + 1}`);
/**
 * The two neutrals of a series chart, never a hue (a hue always means a real category): "No type" and
 * "Other" (past the eighth). Greys placed where they stand furthest from all eight series: "No type" next
 * to the ground (a near-hollow segment, outlined), "Other" in the ladder's widest gap.
 */
export const DATA_NEUTRAL_TOKENS = ["--data-none", "--data-other", "--data-edge-none", "--data-edge-other"];
/** The ink of each series' high-contrast texture: the card or a near-ink tone, whichever stands out more on it. */
export const DATA_MARK_TOKENS = Array.from({ length: DATA_COUNT }, (_, i) => `--data-mark-${i + 1}`);
/**
 * Per look: the chroma of a full-strength series (calmer in soft, firmer in high contrast, where textures
 * help too) and the contrast a series or its outline reaches on the chart's grounds (card, canvas, the
 * bars' muted track).
 */
export const DATA_STYLE: Record<"standard" | "soft" | "high", { c: number; contrast: number }> = {
  standard: { c: 0.095, contrast: 3.1 },
  soft: { c: 0.075, contrast: 3.1 },
  // High contrast: firmer chroma and textures; 3:1 like the others (the bands leave no room for more).
  high: { c: 0.12, contrast: 3.1 },
};
/**
 * The eight series: one family around the base hue, told apart by lightness first. `dh`: degrees from the
 * base along the warm arc (negative: the step back); `c`: share of the look's chroma; `dl`: lightness
 * from the series that just reaches the look's contrast (positive: lighter). Neighbours differ by ≥ 0.08
 * in lightness, alternating light and dark. On terracotta: terracotta, light sand, dark olive, dusty rose,
 * warm slate, muted sage, deep clay, sage-teal; on another base the arc moves with it.
 */
export const DATA_SERIES: readonly { dh: number; c: number; dl: number }[] = [
  { dh: 0, c: 1, dl: 0 },
  { dh: 41, c: 0.65, dl: 0.2 },
  { dh: 62, c: 0.61, dl: -0.226 },
  { dh: -21, c: 0.62, dl: 0.087 },
  { dh: 192, c: 0.26, dl: -0.128 },
  { dh: 90, c: 0.39, dl: 0.199 },
  { dh: 15, c: 0.59, dl: -0.223 },
  { dh: 130, c: 0.39, dl: 0.059 },
];
/** The lightness band of the series: light never near-black (heavy), dark never near-white (glare). */
const DATA_LIGHT_BAND = [0.42, 0.86] as const;
const DATA_DARK_BAND = [0.45, 0.82] as const;
/** Floor for the muted companions: below it a hue is noise and drifts between looks. */
const DATA_MIN_C = 0.03;
/** A grey base has no hue to start from: a warm one, like the default. */
const DATA_NEUTRAL_H = 45;

/**
 * The warm arc's direction from the base: from red-violet to ochre the family steps up towards ochre and
 * olive; from olive to violet it steps down, through teal and sage, never across violet and magenta.
 */
const arcDirection = (h0: number) => (wrap(h0) >= 100 && wrap(h0) < 320 ? -1 : 1);

/**
 * The series colours (`DATA_SERIES`) for one look and scheme, and their outlines. Cool hues are calmer at
 * the same chroma (equal OKLCH chroma reads as louder there), and a muted base keeps a muted family.
 */
function dataTones(base: Oklch, grounds: Rgb[], dark: boolean, style: { c: number; contrast: number }): ThemeVars {
  const grey = base.c < NEUTRAL_C;
  const h0 = grey ? DATA_NEUTRAL_H : base.h;
  const dir = arcDirection(h0);
  const mute = grey ? 1 : Math.min(1, Math.max(0.6, base.c / 0.08));
  const cols = DATA_SERIES.map(s => {
    const h = wrap(h0 + dir * s.dh);
    const cool = h > 170 && h < 300 ? 0.75 : 1;
    return { h, c: Math.max(DATA_MIN_C, style.c * s.c * cool * mute), dl: s.dl };
  });
  // The anchor: the lightness at which every series reaches the contrast (the hardest decides).
  const solved = cols.map(col => solveAgainst(col.h, col.c, grounds, style.contrast, dark ? 0.3 : 0.85, dark ? 1 : 0));
  const vars: ThemeVars = {};
  const dls = DATA_SERIES.map(s => s.dl);
  const [lo, hi] = [Math.min(...dls), Math.max(...dls)];
  // Light: the base at the contrast, the light series above it (outlined), the dark ones below.
  // Dark: from a little under the contrast (the deepest outlined) up to a pale top, squeezed if needed.
  const lightness = (dl: number) => {
    if (!dark) {
      // Light: the base on the contrast line, the ladder squeezed (if needed) into the light band.
      const at = Math.min(...solved);
      const k = Math.min(1, (at - DATA_LIGHT_BAND[0]) / -lo, (DATA_LIGHT_BAND[1] - at) / hi);
      return at + k * dl;
    }
    // Dark: the ladder spread over the dark band, never near-white (glare) nor near the ground.
    return DATA_DARK_BAND[0] + ((dl - lo) / (hi - lo)) * (DATA_DARK_BAND[1] - DATA_DARK_BAND[0]);
  };
  cols.forEach((col, i) => {
    const fill = { l: lightness(col.dl), c: col.c, h: col.h };
    const edgeL = solveAgainst(col.h, col.c, grounds, style.contrast, fill.l, dark ? 1 : 0);
    vars[`--data-${i + 1}`] = tri(fill);
    vars[`--data-edge-${i + 1}`] = tri({ ...fill, l: edgeL });
    const rgbFill = oklchToRgb(fill);
    const ink = oklchToRgb({ l: dark ? 0.95 : 0.22, c: Math.min(col.c, 0.02), h: col.h });
    vars[`--data-mark-${i + 1}`] = toHslTriplet(contrast(ink, rgbFill) > contrast(grounds[0], rgbFill) ? ink : grounds[0]);
  });
  // The neutrals: the grey lightness furthest from every series (normal vision asked more of), on a grid.
  const fills = cols.map(col => oklchToRgb({ l: lightness(col.dl), c: col.c, h: col.h }));
  const neutral = (l: number) => ({ l, c: 0.006, h: h0 });
  const apart = (l: number) =>
    Math.min(...fills.map(f => Math.min(deltaE(oklchToRgb(neutral(l)), f) / 1.6, deltaE(oklchToRgb(neutral(l)), f, "protan"), deltaE(oklchToRgb(neutral(l)), f, "deutan"), deltaE(oklchToRgb(neutral(l)), f, "tritan"))));
  const furthest = (from: number, to: number, skip: (l: number) => boolean) => {
    let best = from;
    let score = -1;
    for (let l = from; l <= to + 1e-9; l += 0.01) {
      const s = skip(l) ? -1 : apart(l);
      if (s > score) [best, score] = [l, s];
    }
    return best;
  };
  const noneL = dark ? furthest(0.26, 0.36, () => false) : furthest(0.9, 0.96, () => false);
  const otherL = furthest(0.3, 0.92, l => Math.abs(l - noneL) < 0.12);
  for (const [name, l] of [["none", noneL], ["other", otherL]] as const) {
    vars[`--data-${name}`] = tri(neutral(l));
    vars[`--data-edge-${name}`] = tri(neutral(solveAgainst(h0, 0.006, grounds, style.contrast, l, dark ? 1 : 0)));
  }
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
  // Another look solves its own series colours: the standard ones would be thrown away.
  const standard = deriveStandard(baseHex, plain);
  if (plain) return standard;
  return deriveLook(baseHex, standard, look);
}

function deriveStandard(baseHex: string, withData = true): Palette {
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
  // Dark covers are a dusk too, with a pale ink: mid-tone tiles left the banner
  // initials near 3.8:1 with either a dark or a pale ink.
  const coverStops: { light: Oklch[]; dark: Oklch[] } = { light: [], dark: [] };
  offsets.forEach(([a, b, d], i) => {
    const stops: [string, Oklch][] = [
      [`--cover-${i}-a`, { l: 0.8 + (i % 3) * 0.03, c: deco(0.075), h: h + a }],
      [`--cover-${i}-b`, { l: 0.86, c: deco(0.06), h: h + b }],
      [`--cover-${i}-c`, { l: 0.92, c: deco(0.035), h: h + d }],
      [`--cover-${i}-bg`, { l: 0.89, c: deco(0.045), h }],
    ];
    for (const [name, col] of stops) {
      const night = { ...col, l: col.l - 0.42, c: col.c * 0.7 };
      light[name] = tone(col);
      dark[name] = tone(night);
      coverStops.light.push(col);
      coverStops.dark.push(night);
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
  // Dark: a dusk band with a pale title, deep enough for AA (a mid-tone band
  // left the dark title near 3:1 on the sign-in cover and the brand mark).
  const dusk = (col: Oklch): Oklch => ({ ...col, l: col.l - 0.42, c: col.c * 0.75 });
  for (const [name, col] of sunset) {
    light[name] = tone(col);
    dark[name] = tone(dusk(col));
  }
  const band = (cols: Oklch[]) => cols.map(col => oklchToRgb({ ...col, c: limit(col.c) }));
  const titleOn = (cols: Oklch[], dark: boolean, chroma: number) =>
    tone({ l: solveAgainst(h, limit(chroma), band(cols), CONTRAST_TARGETS.normal.text, dark ? 0.95 : 0.3, dark ? 1 : 0), c: chroma, h });
  light["--cover-title"] = titleOn(sunset.map(([, col]) => col), false, textC * 0.8);
  light["--cover-ink"] = titleOn(coverStops.light, false, 0.035);
  dark["--cover-ink"] = titleOn(coverStops.dark, true, 0.03);
  dark["--cover-title"] = titleOn(sunset.map(([, col]) => dusk(col)), true, textC * 0.35);

  // ---- data: the categorical series colours (not tone-on-tone: they tell series apart) ----
  if (withData) {
    const grounds = (vars: ThemeVars) => ["--card", "--canvas", "--muted"].map(k => parseTriplet(vars[k]));
    Object.assign(light, dataTones(base, grounds(light), false, DATA_STYLE.standard));
    Object.assign(dark, dataTones(base, grounds(dark), true, DATA_STYLE.standard));
  }

  return { light, dark, base: baseHex.toUpperCase() };
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
    // Soft surfaces are parchment or slate (a tint under the hue rule's floor); standard ones keep the base hue.
    const sh = soft ? lean(dark ? SOFT_SLATE_H : SOFT_PAPER_H, neutral ? null : h) : h;
    const S = SOFT_SURFACE_C;
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
      // The cover title reaches AAA on every stop of the band; in dark the band goes a step deeper for it.
      const stops = [1, 2, 3, 4, 5].map(i => {
        const was = rgbToOklch(parseTriplet(from[`--sunset-${i}`]));
        return dark ? { ...was, l: was.l - 0.1 } : was;
      });
      if (dark) stops.forEach((col, i) => (vars[`--sunset-${i + 1}`] = T(col)));
      const titleC = dark ? textC * 0.3 : textC * 0.6;
      vars["--cover-title"] = T({ l: solveAgainst(h, limit(titleC), stops.map(rgb), target.text, dark ? 0.97 : 0.2, dark ? 1 : 0), c: titleC, h });
      // The covers' ink (banner initials) likewise reaches AAA on every cover stop.
      const coverNames = [0, 1, 2, 3, 4, 5].flatMap(i => ["a", "b", "c", "bg"].map(s => `--cover-${i}-${s}`));
      const tiles = coverNames.map(name => {
        const was = rgbToOklch(parseTriplet(from[name]));
        return dark ? { ...was, l: was.l - 0.1 } : was;
      });
      if (dark) tiles.forEach((col, i) => (vars[coverNames[i]] = T(col)));
      const inkC = dark ? 0.03 : 0.035;
      vars["--cover-ink"] = T({ l: solveAgainst(h, limit(inkC), tiles.map(rgb), target.text, dark ? 0.97 : 0.2, dark ? 1 : 0), c: inkC, h });
    }
    // Series colours solved against this look's own grounds: calmer in soft, firmer in high contrast.
    Object.assign(vars, dataTones(base, [s.card, s.canvas, s.muted].map(rgb), dark, DATA_STYLE[high ? "high" : soft ? "soft" : "standard"]));
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
