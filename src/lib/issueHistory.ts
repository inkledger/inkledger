import { useSyncExternalStore } from "react";

/** An issue: its key on its tracker (the same key may be on another one). */
export type IssueHistoryTarget = { key: string; connectionId?: number };

let target: IssueHistoryTarget | null = null;
const listeners = new Set<() => void>();

/** The issue whose history dialog is open (one at a time, app-wide). */
export const issueHistory = {
  open: (key: string, connectionId?: number) => {
    target = { key, connectionId };
    listeners.forEach(l => l());
  },
  close: () => {
    target = null;
    listeners.forEach(l => l());
  },
};

export function useIssueHistoryTarget(): IssueHistoryTarget | null {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => target
  );
}
