/**
 * What a notification is about, found in what the issue already shows (its comments, its history): the
 * comment that was written, the status change with who made it, the assignment from whom to whom, the
 * sentence that mentions you. Pure, so the matching is tested without a tracker.
 */

/** A notification as the page has it. */
export type NoteRef = { kind: string; detail: string; createdAt: Date; ref: string | null };
/** A comment as `issues.comments` gives it (newest first). */
export type CommentLike = { id: string; author: string; body: string; created: string };
/** A history event as `issues.history` gives it (newest first). */
export type HistoryLike =
  | { kind: "change"; at: number; author: string | null; items: { key: string; from: string | null; to: string | null }[] }
  | { kind: "comment" | "created"; at: number; author: string | null };

/** The sync sees a change after it happened: what came at most this long after the notification is not it. */
const SLACK_MS = 60_000;
const before = (at: number, n: NoteRef) => at <= n.createdAt.getTime() + SLACK_MS;

/** The comment a "commented" is about: by its id when known, else the newest one written before it. */
export function commentFor<C extends CommentLike>(n: NoteRef, comments: readonly C[]): C | null {
  if (n.ref) {
    const exact = comments.find(c => c.id === n.ref);
    if (exact) return exact;
  }
  return comments.find(c => before(Date.parse(c.created), n)) ?? null;
}

/** The comment a mention is in: the newest one before it that mentions someone, else as a comment. */
export function mentionFor<C extends CommentLike>(n: NoteRef, comments: readonly C[]): C | null {
  return comments.find(c => before(Date.parse(c.created), n) && c.body.includes("@")) ?? commentFor(n, comments);
}

/** The sentence around the first mention (or the text's first sentence), at most `max` characters. */
export function mentionExcerpt(text: string, max = 240): string {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const hit = sentences.find(s => s.includes("@")) ?? sentences[0] ?? "";
  if (hit.length <= max) return hit;
  const at = Math.max(0, hit.indexOf("@") - Math.floor(max / 3));
  const cut = hit.slice(at, at + max).trim();
  return `${at > 0 ? "…" : ""}${cut}…`;
}

/** "Da fare → In corso" as the notification's detail says it. */
export function parseFromTo(detail: string): { from: string; to: string } | null {
  const at = detail.indexOf(" → ");
  return at < 0 ? null : { from: detail.slice(0, at).trim(), to: detail.slice(at + 3).trim() };
}

/** A field's change: from, to and who made it (none when the history has nothing to match). */
export type FieldChange = { from: string | null; to: string | null; author: string | null };

/** The newest change of `key` before the notification, matching `match` when given. */
function changeOf(n: NoteRef, events: readonly HistoryLike[], key: string, match?: { from: string; to: string }): FieldChange | null {
  for (const e of events) {
    if (e.kind !== "change" || !before(e.at, n)) continue;
    const item = e.items.find(i => i.key === key && (!match || (i.from === match.from && i.to === match.to)));
    if (item) return { from: item.from, to: item.to, author: e.author };
  }
  return null;
}

/** A status change: its two statuses (from the detail, always there) and who made it (from the history). */
export function statusChange(n: NoteRef, events: readonly HistoryLike[]): FieldChange | null {
  const said = parseFromTo(n.detail);
  const seen = changeOf(n, events, "status", said ?? undefined) ?? (said ? null : changeOf(n, events, "status"));
  if (said) return { ...said, author: seen?.author ?? null };
  return seen;
}

/** An assignment: from whom to whom, and who did it. */
export function assignment(n: NoteRef, events: readonly HistoryLike[]): FieldChange | null {
  return changeOf(n, events, "assignee");
}
