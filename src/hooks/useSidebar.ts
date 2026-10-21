import { useSyncExternalStore } from "react";

const KEY = "ikl-sidebar-collapsed";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let collapsed = read();

/** Desktop sidebar collapsed to an icon rail (per device). */
export const sidebar = {
  toggle: () => {
    collapsed = !collapsed;
    try {
      localStorage.setItem(KEY, collapsed ? "1" : "0");
    } catch {
      /* storage unavailable: applies for this session */
    }
    listeners.forEach(l => l());
  },
};

export function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => collapsed
  );
}
