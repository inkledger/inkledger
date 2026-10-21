import { Maximize2, Minimize2, Monitor, Moon, Sun } from "lucide-react";
import type { Density } from "@/hooks/useDensity";
import { t } from "@/i18n";

/**
 * Theme and density choices (Settings → Appearance, and its summary). Labels
 * are read when asked (getters, or the functions): they follow the language.
 */
export function themes() {
  return [
    { value: "light", label: t("ui.theme.light"), icon: Sun },
    { value: "dark", label: t("ui.theme.dark"), icon: Moon },
    { value: "system", label: t("ui.theme.system"), icon: Monitor },
  ];
}

export function densities(): { value: Density; label: string; icon: typeof Sun }[] {
  return [
    { value: "compact", label: t("ui.density.compact"), icon: Minimize2 },
    { value: "comfortable", label: t("ui.density.comfortable"), icon: Maximize2 },
  ];
}

export const THEMES = [
  { value: "light", get label() { return t("ui.theme.light"); }, icon: Sun },
  { value: "dark", get label() { return t("ui.theme.dark"); }, icon: Moon },
  { value: "system", get label() { return t("ui.theme.system"); }, icon: Monitor },
];

export const DENSITIES: { value: Density; label: string; icon: typeof Sun }[] = [
  { value: "compact", get label() { return t("ui.density.compact"); }, icon: Minimize2 },
  { value: "comfortable", get label() { return t("ui.density.comfortable"); }, icon: Maximize2 },
];
