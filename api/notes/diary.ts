// The diary's days as the server reads them, bodies included (the page has
// the tree only): what "Summary" and "Copy for model" send to a model.
import { and, eq, gt, gte, inArray, isNull, lt } from "drizzle-orm";
import { issues, mailLinks, mails, markdownNotes, plannedEntries, worklogs } from "@db/schema";
import { diaryDays, diaryMarkdown, type DiaryDay } from "@contracts/diary";
import { getDb } from "../queries/connection";

/** About this many characters of diary for a local model (≈ 8k tokens): longer notes are cut, never the days. */
export const DIARY_BUDGET_CHARS = 28_000;

export type DiaryRange = { fromDay: string; toDay: string; from: string; to: string; folderId?: string | null };

/** Notes under `folderId` (any depth); every note when null. */
async function notesIn(userId: number, range: DiaryRange) {
  const rows = await getDb()
    .select({ id: markdownNotes.id, parentId: markdownNotes.parentId, kind: markdownNotes.kind, title: markdownNotes.title, body: markdownNotes.body, notedOn: markdownNotes.notedOn })
    .from(markdownNotes)
    .where(and(eq(markdownNotes.userId, userId), isNull(markdownNotes.deletedAt)));
  const byId = new Map(rows.map(r => [r.id, r]));
  const inside = (id: string | null): boolean => {
    if (!range.folderId) return true;
    for (let at = id, n = 0; at && n < 64; at = byId.get(at)?.parentId ?? null, n++) if (at === range.folderId) return true;
    return false;
  };
  return rows
    .filter(r => r.kind === "note" && r.notedOn && r.notedOn >= range.fromDay && r.notedOn <= range.toDay && inside(r.parentId))
    .map(r => ({ id: r.id, title: r.title, body: r.body, notedOn: r.notedOn as string }));
}

export async function diaryFor(userId: number, range: DiaryRange): Promise<DiaryDay[]> {
  const db = getDb();
  const from = new Date(range.from);
  const to = new Date(range.to);
  const [notes, logs, planned, pinned] = await Promise.all([
    notesIn(userId, range),
    db
      .select({ issueKey: worklogs.issueKey, connectionId: worklogs.connectionId, seconds: worklogs.timeSpentSeconds, started: worklogs.started, comment: worklogs.comment })
      .from(worklogs)
      .where(and(eq(worklogs.userId, userId), gte(worklogs.started, from), lt(worklogs.started, to))),
    db
      .select({ kind: plannedEntries.kind, startsAt: plannedEntries.startsAt, endsAt: plannedEntries.endsAt, issueKey: plannedEntries.issueKey, note: plannedEntries.note })
      .from(plannedEntries)
      .where(and(eq(plannedEntries.userId, userId), lt(plannedEntries.startsAt, to), gt(plannedEntries.endsAt, from))),
    db
      .select({ subject: mails.subject, fromName: mails.fromName, pinnedAt: mailLinks.createdAt, issueKey: mailLinks.issueKey })
      .from(mailLinks)
      .innerJoin(mails, eq(mails.id, mailLinks.mailId))
      .where(and(eq(mailLinks.userId, userId), gte(mailLinks.createdAt, from), lt(mailLinks.createdAt, to))),
  ]);
  const keys = [...new Set(logs.map(w => w.issueKey))];
  const named = keys.length
    ? await db
        .select({ key: issues.key, connectionId: issues.connectionId, summary: issues.summary })
        .from(issues)
        .where(and(eq(issues.userId, userId), inArray(issues.key, keys)))
    : [];
  const summaryOf = new Map(named.map(i => [`${i.connectionId}:${i.key}`, i.summary]));
  return diaryDays(range.fromDay, range.toDay, {
    notes,
    worklogs: logs.map(w => ({ ...w, summary: summaryOf.get(`${w.connectionId}:${w.issueKey}`) })),
    planned,
    mails: pinned,
  });
}

/** The days as Markdown within the budget: each note's text is cut shorter until it fits. */
export function diaryText(days: DiaryDay[]): { markdown: string; cut: boolean } {
  let noteChars = 4000;
  let markdown = diaryMarkdown(days, { noteChars });
  while (markdown.length > DIARY_BUDGET_CHARS && noteChars > 200) {
    noteChars = Math.floor(noteChars / 2);
    markdown = diaryMarkdown(days, { noteChars });
  }
  return { markdown: markdown.slice(0, DIARY_BUDGET_CHARS), cut: noteChars < 4000 || markdown.length > DIARY_BUDGET_CHARS };
}
