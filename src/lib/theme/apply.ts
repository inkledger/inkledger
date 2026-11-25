import { writeStored } from "@/lib/storage";
import { THEME_CONTRASTS, THEME_VARIANTS, type ThemeContrastSetting, type ThemeVariantSetting } from "@contracts/theme";
import { derivePalette, type ThemeContrast, type ThemeVars } from "./derive";

/** localStorage key read by the inline script in index.html (no flash). */
const THEME_CACHE_KEY = "ikl-theme-css";
/** The variant and contrast choice, read by the same script to set the html attributes before the first paint. */
const LOOK_CACHE_KEY = "ikl-appearance";
const STYLE_ID = "theme-vars";
const MORE_CONTRAST = "(prefers-contrast: more)";

export type AppearancePrefs = { variant: ThemeVariantSetting; contrast: ThemeContrastSetting };
export const DEFAULT_PREFS: AppearancePrefs = { variant: "standard", contrast: "system" };

const block = (selector: string, vars: ThemeVars) =>
  `${selector}{${Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";")}}`;

/**
 * CSS overriding the static tokens in index.css, for one variant: light and dark at normal
 * contrast, then both at high contrast. `html:root` / `html.dark` outrank `:root` / `.dark`, and
 * `html[data-contrast="high"]:root` outranks the static `:root[data-contrast="high"]`. Every
 * block is whole: in dark mode the light high-contrast block matches too, and the dark one,
 * written after it, must replace every value.
 */
export function themeCss(baseHex: string, variant: ThemeVariantSetting = "standard"): string {
  const p = derivePalette(baseHex, { variant, contrast: "normal" });
  const hc = derivePalette(baseHex, { variant, contrast: "high" });
  return (
    block("html:root", p.light) +
    block("html.dark", p.dark) +
    block('html[data-contrast="high"]:root', hc.light) +
    block('html.dark[data-contrast="high"]', hc.dark)
  );
}

/** Prefs from untrusted strings (the add-in's answer): anything unknown is the default. */
export function appearancePrefs(variant: unknown, contrast: unknown): AppearancePrefs {
  return {
    variant: THEME_VARIANTS.find(v => v === variant) ?? DEFAULT_PREFS.variant,
    contrast: THEME_CONTRASTS.find(c => c === contrast) ?? DEFAULT_PREFS.contrast,
  };
}

/** The contrast in use: the choice, or the system's when the choice is "system". */
export function resolveContrast(pref: ThemeContrastSetting): ThemeContrast {
  if (pref !== "system") return pref;
  return typeof window !== "undefined" && window.matchMedia?.(MORE_CONTRAST).matches ? "high" : "normal";
}

/** Follows the system's contrast while the choice is "system"; returns the unsubscribe. */
export function watchSystemContrast(pref: ThemeContrastSetting): () => void {
  if (pref !== "system" || typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(MORE_CONTRAST);
  const on = () => {
    document.documentElement.dataset.contrast = query.matches ? "high" : "normal";
  };
  query.addEventListener("change", on);
  return () => query.removeEventListener("change", on);
}

/** Apply a base colour and look to the whole app; `persist` caches them for the next load. */
export function applyTheme(baseHex: string, persist = true, prefs: AppearancePrefs = DEFAULT_PREFS): void {
  const css = themeCss(baseHex, prefs.variant);
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
  // The palette first, then the attributes: their change is what the modules' host watches.
  const root = document.documentElement;
  root.dataset.variant = prefs.variant;
  root.dataset.contrast = resolveContrast(prefs.contrast);
  root.dataset.themeBase = baseHex.toUpperCase();
  // Storage unavailable: the theme still applies for this session.
  if (persist) {
    writeStored(THEME_CACHE_KEY, css);
    writeStored(LOOK_CACHE_KEY, JSON.stringify(prefs));
  }
}
