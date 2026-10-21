import { createIssueDialog } from "@/lib/flag";

export type CreateIssuePrefill = {
  summary?: string;
  description?: string;
  /** Called with the new key once created (e.g. link a post-it to it). */
  onCreated?: (key: string, connectionId: number) => void;
};

let pending: CreateIssuePrefill | null = null;

/** Open "New issue", optionally filled in (a free post-it becoming an issue). */
export function openCreateIssue(prefill?: CreateIssuePrefill) {
  pending = prefill ?? null;
  createIssueDialog.set(true);
}

/** Read once by the dialog when it opens. */
export function takeCreateIssuePrefill(): CreateIssuePrefill | null {
  const p = pending;
  pending = null;
  return p;
}
