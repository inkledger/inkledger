import type { Locale, MessageKey } from "@/i18n";
import type { Scene } from "./scenes/types";
import { ink } from "./scenes/ink";

/** The host's own scenes, in the order ← / → walk them. */
export const BUILT_IN: readonly (Scene & { labelKey: MessageKey })[] = [{ ...ink, labelKey: "ui.screensaver.scene.ink" }];

export type SceneChoice = { id: string; label: string; mod?: string };

/** Every scene to choose from: the host's, then one per add-on offering the screensaver slot. */
export function sceneList(
  mods: readonly { id: string; name: { en: string; it: string }; slots: readonly string[] }[],
  locale: Locale,
  label: (key: MessageKey) => string
): SceneChoice[] {
  return [
    ...BUILT_IN.map(s => ({ id: s.id, label: label(s.labelKey) })),
    ...mods.filter(m => m.slots.includes("screensaver")).map(m => ({ id: `mod:${m.id}`, label: m.name[locale], mod: m.id })),
  ];
}

/** The scene `step` places from `id` (wrapping), or the first when `id` is not in the list. */
export function stepScene(list: readonly SceneChoice[], id: string, step: number): SceneChoice | undefined {
  const at = list.findIndex(s => s.id === id);
  if (at < 0) return list[0];
  return list[(((at + step) % list.length) + list.length) % list.length];
}
