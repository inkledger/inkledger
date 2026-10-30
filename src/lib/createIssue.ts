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

/**
 * What the dialog opens with. Reading never clears it: a render React throws
 * away (the lazy form suspending) reads it again; the dialog clears it on closing.
 */
export function takeCreateIssuePrefill(): CreateIssuePrefill | null {
  return pending;
}

/** The dialog closed: the next opening starts empty unless filled again. */
export function clearCreateIssuePrefill() {
  pending = null;
}
