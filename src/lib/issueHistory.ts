import { useSyncExternalStore } from "react";

let key: string | null = null;
const listeners = new Set<() => void>();

/** The issue whose history dialog is open (one at a time, app-wide). */
export const issueHistory = {
  open: (k: string) => {
    key = k;
    listeners.forEach(l => l());
  },
  close: () => {
    key = null;
    listeners.forEach(l => l());
  },
};

export function useIssueHistoryKey(): string | null {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => key
  );
}
