/** Settings → Appearance, shared by the server (validation) and the app (src/lib/theme). */
export const THEME_VARIANTS = ["standard", "soft"] as const;
export type ThemeVariantSetting = (typeof THEME_VARIANTS)[number];
/** "system" follows the system's "more contrast" (prefers-contrast: more). */
export const THEME_CONTRASTS = ["normal", "high", "system"] as const;
export type ThemeContrastSetting = (typeof THEME_CONTRASTS)[number];
