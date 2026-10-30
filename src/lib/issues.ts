import { relativeFormat, t } from "@contracts/i18n";

/** Issue fields used by the helpers below (any issue list row fits). */
type ActivityFields = {
  activityAt: number | null;
  lastCommentAt: number | null;
  statusChangedAt: number | null;
};

function ago(ms: number): string {
  const days = Math.round((ms - Date.now()) / 864e5);
  if (days === 0) return t("ui.rel.today");
  if (Math.abs(days) < 31) return relativeFormat().format(days, "day");
  return relativeFormat().format(Math.round(days / 30), "month");
}

/** Why the issue sits where it does in the "Activity" order. */
export function activityText(issue: ActivityFields): string | null {
  const at = issue.activityAt;
  if (!at) return null;
  const what =
    at === issue.lastCommentAt
      ? t("ui.activity.comment")
      : at === issue.statusChangedAt
        ? t("ui.activity.status")
        : t("ui.activity.created");
  return `${what} · ${ago(at)}`;
}

/** Most relevant first (last change, activity or creation); unknown last. */
export function byRelevance<T extends { relevantAt: number | null }>(
  a: T,
  b: T
): number {
  return (b.relevantAt ?? 0) - (a.relevantAt ?? 0);
}

/** "2 h ago", "yesterday", "3 days ago"… for a card. */
export function relevanceText(ms: number, now = Date.now()): string {
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return t("ui.rel.now");
  if (min < 60) return relativeFormat().format(-min, "minute");
  const h = Math.round(min / 60);
  if (h < 24) return relativeFormat().format(-h, "hour");
  return ago(ms);
}

/** Hidden issues stay in sync but out of every list. */
export function visibleIssues<T extends { hidden: number }>(rows: T[]): T[] {
  return rows.filter(r => r.hidden !== 1);
}

/**
 * Git branch for an issue: "feature/DEMO-123-short-title" (ASCII slug of the
 * first words of the summary, accents folded).
 */
export function branchName(key: string, summary: string, words = 6): string {
  const slug = summary
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, words)
    .join("-");
  return slug ? `feature/${key}-${slug}` : `feature/${key}`;
}

/** Copy to the clipboard; false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy text the server is still making: the clipboard is claimed now, while
 * the click still counts as the user's (Safari refuses a write after an
 * await), and filled when the text arrives. False when the browser refuses
 * or the text never comes.
 */
export async function copyLater(text: Promise<string>): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then(v => new Blob([v], { type: "text/plain" })) })]);
    } else {
      await navigator.clipboard.writeText(await text);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * One identity for an issue in maps and React keys: a key is unique only
 * per connection (two trackers can both have APP-1).
 */
export function issueId(i: { key?: string; issueKey?: string; connectionId?: number | null }): string {
  return `${i.connectionId ?? 0}:${i.key ?? i.issueKey ?? ""}`;
}

/**
 * The link to an issue: by its identity on its connection when known (it
 * survives a key change), else by its key (the page resolves it, old keys
 * included). The only place issue links are made (lint rule).
 */
export function issuePath(issue: { key: string; connectionId?: number | null; remoteId?: string | null }): string {
  if (issue.connectionId && issue.remoteId) return `/issues/${issue.connectionId}/${encodeURIComponent(issue.remoteId)}`;
  // Its connection known, its id not (a timer, a notification): the key on that connection.
  const on = issue.connectionId ? `?c=${issue.connectionId}` : "";
  return `/issues/${encodeURIComponent(issue.key)}${on}`;
}
