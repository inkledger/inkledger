import { deviceSetting, writeStored } from "@/lib/storage";

const KEY = "ikl-sidebar-sections";

/** Section ids saved before they were English. */
const LEGACY_IDS: Record<string, string> = {
  Principale: "main",
  Analisi: "analysis",
  Altro: "other",
  Preferite: "favorites",
};

const closed = deviceSetting<string[]>(
  KEY,
  raw => {
    let v: unknown;
    try {
      v = JSON.parse(raw ?? "[]");
    } catch {
      return [];
    }
    if (!Array.isArray(v)) return [];
    const ids = v.filter((x): x is string => typeof x === "string").map(x => LEGACY_IDS[x] ?? x);
    const migrated = [...new Set(ids)];
    // Saved again under the English ids (a refused write: migrated again next time).
    if (migrated.join() !== v.join()) writeStored(KEY, JSON.stringify(migrated));
    return migrated;
  },
  JSON.stringify,
);

/** Sidebar sections folded to their title (per device). */
export const sidebarSections = {
  toggle: (name: string) => {
    const now = closed.get();
    closed.set(now.includes(name) ? now.filter(n => n !== name) : [...now, name]);
  },
};

export function useSidebarSectionsClosed(): string[] {
  return closed.use();
}
