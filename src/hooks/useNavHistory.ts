import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useLocation, useNavigate, useNavigationType, NavigationType } from "react-router";
import { navHistory, pageLabel, parentOf, type NavFrom } from "@/lib/navHistory";

/**
 * Records, for every history entry, the page it was opened from (AppLayout,
 * once). A replace (filters typed into the URL) keeps the entry's origin.
 */
export function useNavHistoryRecorder() {
  const location = useLocation();
  const type = useNavigationType();
  const last = useRef<{ key: string; from: NavFrom } | null>(null);
  useLayoutEffect(() => {
    const here: NavFrom = { path: location.pathname + location.search, label: pageLabel(location.pathname) };
    const prev = last.current;
    if (prev && prev.key !== location.key) {
      if (type === NavigationType.Push && prev.from.path.split("?")[0] !== location.pathname) navHistory.record(location.key, prev.from);
      if (type === NavigationType.Replace) {
        const origin = navHistory.from(prev.key);
        if (origin) navHistory.record(location.key, origin);
      }
    }
    last.current = { key: location.key, from: here };
  }, [location.key, location.pathname, location.search, type]);
}

/**
 * Where "back" goes from this page: the page it was opened from (with its
 * filters and scroll, through the browser history), else the section a
 * detail page belongs to. Null on a top page opened directly.
 */
export function useBack(): (NavFrom & { go: () => void }) | null {
  const location = useLocation();
  const navigate = useNavigate();
  useSyncExternalStore(navHistory.subscribe, navHistory.snapshot);
  const from = navHistory.from(location.key);
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
  if (from && idx > 0) return { ...from, go: () => void navigate(-1) };
  const parent = parentOf(location.pathname);
  return parent ? { ...parent, go: () => void navigate(parent.path) } : null;
}
