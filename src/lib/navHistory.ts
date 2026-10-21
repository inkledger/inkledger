import { navEntryFor } from "@/lib/nav";
import { t } from "@/i18n";

/** Where a history entry was opened from: shown as "← Board" and in the breadcrumb. */
export type NavFrom = { path: string; label: string };

const KEY = "ikl-nav-from";
const MAX = 200;

/** The name of the page at `path`, as a back button says it. */
export function pageLabel(pathname: string): string {
  const issue = /^\/issues\/([^/]+)$/.exec(pathname);
  if (issue) return decodeURIComponent(issue[1]);
  return navEntryFor(pathname)?.label ?? t("ui.nav.back");
}

let froms: Record<string, NavFrom> = (() => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Record<string, NavFrom>;
  } catch {
    return {};
  }
})();
const listeners = new Set<() => void>();

export const navHistory = {
  /** Remembers where the entry `key` came from (kept for the tab's session). */
  record: (key: string, from: NavFrom) => {
    if (froms[key]?.path === from.path) return;
    const entries = Object.entries({ ...froms, [key]: from });
    froms = Object.fromEntries(entries.slice(-MAX));
    try {
      sessionStorage.setItem(KEY, JSON.stringify(froms));
    } catch {
      // storage unavailable: kept for this page load only
    }
    listeners.forEach(l => l());
  },
  from: (key: string): NavFrom | undefined => froms[key],
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  snapshot: () => froms,
};

/** The page a detail page belongs to when opened directly (no history). */
export function parentOf(pathname: string): NavFrom | null {
  const entry = navEntryFor(pathname);
  if (!entry || entry.to === pathname) return null;
  return { path: entry.to, label: entry.label };
}
