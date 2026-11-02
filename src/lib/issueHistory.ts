import { createStore } from "@/lib/store";

/** An issue: its key on its tracker (the same key may be on another one). */
export type IssueHistoryTarget = { key: string; connectionId?: number };

const target = createStore<IssueHistoryTarget | null>(null);

/** The issue whose history dialog is open (one at a time, app-wide). */
export const issueHistory = {
  open: (key: string, connectionId?: number) => target.set({ key, connectionId }),
  close: () => target.set(null),
};

export const useIssueHistoryTarget = target.use;
