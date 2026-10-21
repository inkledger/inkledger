import { useSyncExternalStore } from "react";

const KEY = "ikl-sidebar-sections";
const listeners = new Set<() => void>();

/** Section ids saved before they were English. */
const LEGACY_IDS: Record<string, string> = {
  Principale: "main",
  Analisi: "analysis",
  Altro: "other",
  Preferite: "favorites",
};

function read(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    const ids = v.filter((x): x is string => typeof x === "string").map(x => LEGACY_IDS[x] ?? x);
    const migrated = [...new Set(ids)];
    if (migrated.join() !== v.join()) localStorage.setItem(KEY, JSON.stringify(migrated));
    return migrated;
  } catch {
    return [];
  }
}

let closed = read();

/** Sidebar sections folded to their title (per device). */
export const sidebarSections = {
  toggle: (name: string) => {
    closed = closed.includes(name) ? closed.filter(n => n !== name) : [...closed, name];
    try {
      localStorage.setItem(KEY, JSON.stringify(closed));
    } catch {
      /* storage unavailable: applies for this session */
    }
    listeners.forEach(l => l());
  },
};

export function useSidebarSectionsClosed(): string[] {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => closed
  );
}
