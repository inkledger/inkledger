import { derivePalette, type ThemeVars } from "./derive";

/** localStorage key read by the inline script in index.html (no flash). */
export const THEME_CACHE_KEY = "ikl-theme-css";
const STYLE_ID = "theme-vars";

const block = (selector: string, vars: ThemeVars) =>
  `${selector}{${Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";")}}`;

/**
 * CSS overriding the static tokens in index.css. `html:root` / `html.dark`
 * outrank `:root` / `.dark` regardless of stylesheet order.
 */
export function themeCss(baseHex: string): string {
  const p = derivePalette(baseHex);
  return block("html:root", p.light) + block("html.dark", p.dark);
}

/** Apply a base colour to the whole app; `persist` caches it for the next load. */
export function applyTheme(baseHex: string, persist = true): void {
  const css = themeCss(baseHex);
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = css;
  if (persist) {
    try {
      localStorage.setItem(THEME_CACHE_KEY, css);
    } catch {
      /* storage unavailable: the theme still applies for this session */
    }
  }
}
