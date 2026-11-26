import type { NotificationKind } from "./notifications";

/**
 * The notifications page's smart grouping (shared FE / tests): a category per kind, the page's
 * filters (category, state), one group per issue, and where the selection goes when a group leaves.
 * Pure, so the triage flow's rules are tested without a browser.
 */

/** The categories the page navigates, "all" first. */
export const NOTIFICATION_CATEGORIES = ["all", "mentions", "comments", "status", "assignments", "other"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
export type KindCategory = Exclude<NotificationCategory, "all">;

/** Every kind in exactly one category: asked of you, said, moved, given to you, the rest. */
export const CATEGORY_OF: Record<NotificationKind, KindCategory> = {
  mentioned: "mentions",
  review: "mentions",
  commented: "comments",
  status: "status",
  assigned: "assignments",
  unassigned: "assignments",
  priority: "other",
  due: "other",
  watch_added: "other",
  watch_removed: "other",
  changed: "other",
};

/** Unread and read are the open ones; done are the dismissed ones (another query). */
export const INBOX_STATES = ["unread", "read", "done"] as const;
export type InboxState = (typeof INBOX_STATES)[number];

export type InboxItem = {
  id: number;
  kind: NotificationKind;
  issueKey: string;
  connectionId: number;
  createdAt: Date;
  readAt: Date | null;
};

/** One issue's notifications: the key the URL keeps (stable while new ones arrive), newest first. */
export type InboxGroup<T extends InboxItem> = {
  key: string;
  issueKey: string;
  connectionId: number;
  items: T[];
  latest: T;
  unread: number;
};

/** A group's key: the issue on its connection (the same text as `issueId`). */
export const groupKey = (n: Pick<InboxItem, "connectionId" | "issueKey">): string => `${n.connectionId}:${n.issueKey}`;

/**
 * What the state shows: done shows all it is given (the done query); unread the unread ones, and
 * the groups in `keep` (read while looked at: they stay in place until the filter changes); read the read ones.
 */
export function inState<T extends InboxItem>(items: readonly T[], state: InboxState, keep: ReadonlySet<string> = new Set()): T[] {
  if (state === "done") return [...items];
  if (state === "read") return items.filter((n) => n.readAt !== null);
  return items.filter((n) => n.readAt === null || keep.has(groupKey(n)));
}

export function inCategory<T extends InboxItem>(items: readonly T[], category: NotificationCategory): T[] {
  return category === "all" ? [...items] : items.filter((n) => CATEGORY_OF[n.kind] === category);
}

/** How many notifications each category holds (in the state already applied). */
export function categoryCounts(items: readonly InboxItem[]): Record<NotificationCategory, number> {
  const out = Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, 0])) as Record<NotificationCategory, number>;
  for (const n of items) {
    out.all++;
    out[CATEGORY_OF[n.kind]]++;
  }
  return out;
}

/** One group per issue, newest group first, newest first within each (whatever order they came in). */
export function groupByIssue<T extends InboxItem>(items: readonly T[]): InboxGroup<T>[] {
  const sorted = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
  const byKey = new Map<string, T[]>();
  for (const n of sorted) {
    const key = groupKey(n);
    const list = byKey.get(key);
    if (list) list.push(n);
    else byKey.set(key, [n]);
  }
  return [...byKey.entries()].map(([key, list]) => ({
    key,
    issueKey: list[0].issueKey,
    connectionId: list[0].connectionId,
    items: list,
    latest: list[0],
    unread: list.filter((n) => n.readAt === null).length,
  }));
}

/** "3 comments, 1 status change": how many of each category a group holds, the largest first (ties in page order). */
export function groupSummary(items: readonly InboxItem[]): { category: KindCategory; count: number }[] {
  const counts = new Map<KindCategory, number>();
  for (const n of items) counts.set(CATEGORY_OF[n.kind], (counts.get(CATEGORY_OF[n.kind]) ?? 0) + 1);
  const order = NOTIFICATION_CATEGORIES.slice(1) as readonly KindCategory[];
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || order.indexOf(a.category) - order.indexOf(b.category));
}

/**
 * Where the selection goes when `current` leaves the list (done, read under "unread"): the next one,
 * else the one before, else none. Asked before it leaves, on the list as it is.
 */
export function nextAfter(keys: readonly string[], current: string): string | null {
  const at = keys.indexOf(current);
  if (at < 0) return keys[0] ?? null;
  return keys[at + 1] ?? keys[at - 1] ?? null;
}
