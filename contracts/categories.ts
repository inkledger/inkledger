// The canonical categories every tracker's statuses are grouped by (D2, T1):
// only for grouping, counting and notices; a status itself stays its
// service's own. Shared by the server and the app.
import type { StatusCategory } from "./providers";

export const CATEGORY_ORDER: readonly StatusCategory[] = ["triage", "backlog", "todo", "doing", "done", "cancelled"];

/** Finished one way or the other (`cat:closed`): done or cancelled. */
export const isClosed = (c: string) => c === "done" || c === "cancelled";

/** Waiting to be started: triage, backlog, to do. */
export const isWaiting = (c: string) => c === "triage" || c === "backlog" || c === "todo";

/** Position in the board's order (unknown last). */
export const categoryRank = (c: string) => {
  const i = CATEGORY_ORDER.indexOf(c as StatusCategory);
  return i < 0 ? CATEGORY_ORDER.length : i;
};

/**
 * A priority's rank, 0 (highest) … 4 (lowest): its native position scaled
 * onto five steps, on purpose coarse and the same for every tracker (six
 * priorities share some steps). One priority: the middle; none: null.
 */
export function priorityRankOf(index: number, count: number): number | null {
  if (count <= 0 || index < 0 || index >= count) return null;
  if (count === 1) return 2;
  return Math.round((index * 4) / (count - 1));
}

/**
 * The category of a status group stored by its canonical name ("To Do",
 * "In Progress", "Done": Jira's three groups, read by key when the service
 * gives it); any other group counts as to do.
 */
export const categoryOfGroup = (group: string): StatusCategory => (group === "Done" ? "done" : group === "In Progress" ? "doing" : "todo");
