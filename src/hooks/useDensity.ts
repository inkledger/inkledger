import { useSyncExternalStore } from "react";

export type Density = "compact" | "comfortable";

const KEY = "ikl-density";
const listeners = new Set<() => void>();

function read(): Density {
  try {
    return localStorage.getItem(KEY) === "comfortable"
      ? "comfortable"
      : "compact";
  } catch {
    return "compact";
  }
}

/** UI density (per device): "compact" zooms the whole app out to ~88%. */
export function useDensity(): [Density, (d: Density) => void] {
  const density = useSyncExternalStore(l => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, read);
  const set = (d: Density) => {
    try {
      localStorage.setItem(KEY, d);
    } catch {
      /* storage unavailable: still apply for this session */
    }
    document.documentElement.dataset.density = d;
    for (const l of listeners) l();
  };
  return [density, set];
}
