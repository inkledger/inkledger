// The app's glyph (an octopus in order) as the app draws it: the same paths
// as scripts/icon-glyph.mjs, which draws the OS icons (api/icons.test.ts
// keeps them equal).
export const BRAND_HEAD = "M9 15.5a7 7 0 0 1 14 0";
export const BRAND_ARMS = "M9 15.5v5.5a2.5 2.5 0 0 1 -2.5 2.5M13.67 15.5v8M18.33 15.5v8M23 15.5v5.5a2.5 2.5 0 0 0 2.5 2.5";
export const BRAND_HEAD_OPACITY = 0.45;
/** The OS icons' ink and paper (the favicon's tile and glyph), for icons drawn at run time. */
export const BRAND_INK = "hsl(24 12% 9%)";
export const BRAND_PAPER = "hsl(36 30% 97%)";
/** The short name, beside the glyph. */
export const BRAND_SHORT = "ikl";
