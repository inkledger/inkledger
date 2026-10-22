import { Maximize2, Minimize2, Monitor, Moon, Sun } from "lucide-react";
import type { Density } from "@/hooks/useDensity";
import { t } from "@/i18n";

export const THEMES = [
  { value: "light", get label() { return t("ui.theme.light"); }, icon: Sun },
  { value: "dark", get label() { return t("ui.theme.dark"); }, icon: Moon },
  { value: "system", get label() { return t("ui.theme.system"); }, icon: Monitor },
];

export const DENSITIES: { value: Density; label: string; icon: typeof Sun }[] = [
  { value: "compact", get label() { return t("ui.density.compact"); }, icon: Minimize2 },
  { value: "comfortable", get label() { return t("ui.density.comfortable"); }, icon: Maximize2 },
];
