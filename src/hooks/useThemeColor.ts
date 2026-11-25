import { useEffect, useMemo, useSyncExternalStore } from "react";
import { trpc } from "@/lib/trpc";
import { appearancePrefs, applyTheme, watchSystemContrast, type AppearancePrefs } from "@/lib/theme/apply";
import { DEFAULT_BASE } from "@/lib/theme/derive";

// Unsaved colour being tried in Settings (null = use the saved one).
let preview: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export const themePreview = {
  set(hex: string | null) {
    preview = hex;
    emit();
  },
};

function usePreview(): string | null {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => preview,
    () => preview
  );
}

/** Saved base colour, the colour on screen, and whether a preview is active. */
export function useThemeColor() {
  const settings = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  const saved = settings.data?.themeColor ?? DEFAULT_BASE;
  const previewing = usePreview();
  return {
    saved,
    current: previewing ?? saved,
    previewing: previewing !== null,
    loaded: !!settings.data,
  };
}

/** The saved variant and contrast (Settings → Appearance). */
export function useAppearancePrefs(): AppearancePrefs {
  const data = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 }).data;
  const { variant, contrast } = appearancePrefs(data?.themeVariant, data?.themeContrast);
  return useMemo(() => ({ variant, contrast }), [variant, contrast]);
}

/** Keeps the document palette in sync with the saved colour and look, or the live preview. */
export function useThemeSync() {
  const { current, previewing, loaded } = useThemeColor();
  const prefs = useAppearancePrefs();
  useEffect(() => {
    // Only cache what is saved; previews are transient.
    if (loaded || previewing) applyTheme(current, !previewing, prefs);
  }, [current, previewing, loaded, prefs]);
  // "Follow the system": the system's contrast setting can change while the app is open.
  useEffect(() => (loaded ? watchSystemContrast(prefs.contrast) : undefined), [loaded, prefs.contrast]);
}
