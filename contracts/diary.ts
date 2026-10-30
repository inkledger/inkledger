// The diary (notes → Diary): each day's notes, logged time, planned work and pinned
// mails, and the same days as Markdown for a model to summarize or put in order
// (a report on activities or meetings). Shared: the page draws the days, the
// server writes them for the model.
import { escapeMd } from "./richtext";
import { addDays, dayKey, formatDurationLong, parseDayKey } from "./time";

export type DiaryMode = "summary" | "timeline";
export const DIARY_MAX_DAYS = 31;

export type DiaryNote = { id: string; title: string; notedOn: string; body?: string };
export type DiaryWorklog = { issueKey: string; summary?: string; seconds: number; started: Date; comment?: string | null };
export type DiaryPlanned = { kind: string; startsAt: Date; endsAt: Date; issueKey?: string | null; note?: string | null };
export type DiaryMail = { subject: string; fromName?: string | null; pinnedAt: Date; issueKey?: string | null };

export type DiaryIssue = { issueKey: string; summary?: string; seconds: number; comments: string[] };
export type DiaryDay = {
  day: string;
  notes: DiaryNote[];
  /** The day's time per issue, most first */
  issues: DiaryIssue[];
  loggedSeconds: number;
  planned: DiaryPlanned[];
  mails: DiaryMail[];
};

/** The days from `fromDay` to `toDay` (inclusive, at most DIARY_MAX_DAYS), each with what belongs to it. */
export function diaryDays(
  fromDay: string,
  toDay: string,
  input: { notes: DiaryNote[]; worklogs: DiaryWorklog[]; planned: DiaryPlanned[]; mails: DiaryMail[] }
): DiaryDay[] {
  const from = parseDayKey(fromDay);
  const to = parseDayKey(toDay);
  if (!from || !to || to < from) return [];
  const days: DiaryDay[] = [];
  for (let d = from, n = 0; d <= to && n < DIARY_MAX_DAYS; d = addDays(d, 1), n++) {
    const key = dayKey(d);
    const logs = input.worklogs.filter(w => dayKey(w.started) === key);
    const byIssue = new Map<string, DiaryIssue>();
    for (const w of logs) {
      const at = byIssue.get(w.issueKey) ?? { issueKey: w.issueKey, summary: w.summary, seconds: 0, comments: [] };
      at.seconds += w.seconds;
      const comment = w.comment?.trim();
      if (comment && !at.comments.includes(comment)) at.comments.push(comment);
      byIssue.set(w.issueKey, at);
    }
    days.push({
      day: key,
      notes: input.notes.filter(x => x.notedOn === key),
      issues: [...byIssue.values()].sort((a, b) => b.seconds - a.seconds),
      loggedSeconds: logs.reduce((a, w) => a + w.seconds, 0),
      planned: input.planned.filter(p => dayKey(p.startsAt) <= key && key <= dayKey(new Date(p.endsAt.getTime() - 1))),
      mails: input.mails.filter(m => dayKey(m.pinnedAt) === key),
    });
  }
  return days;
}

export const diaryDayIsEmpty = (d: DiaryDay) => !d.notes.length && !d.issues.length && !d.planned.length && !d.mails.length;

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * The days as Markdown, for a model: one section per day with something in it,
 * notes with their text (cut to `noteChars` each, said when cut), time per issue
 * with the worklogs' comments, planned work, pinned mails.
 */
export function diaryMarkdown(days: DiaryDay[], o: { noteChars?: number } = {}): string {
  const max = o.noteChars ?? 4000;
  const out: string[] = [];
  for (const d of days) {
    if (diaryDayIsEmpty(d)) continue;
    out.push(`## ${d.day}`, "");
    for (const n of d.notes) {
      out.push(`### Note: ${escapeMd(n.title || "(untitled)")}`, "");
      const body = (n.body ?? "").trim();
      if (body) out.push(body.length > max ? `${body.slice(0, max)}\n\n[… cut, ${body.length - max} more characters]` : body, "");
    }
    if (d.issues.length) {
      out.push(`### Time logged: ${formatDurationLong(d.loggedSeconds)}`, "");
      for (const i of d.issues) {
        out.push(`- ${i.issueKey}${i.summary ? ` ${escapeMd(i.summary)}` : ""}: ${formatDurationLong(i.seconds)}`);
        for (const c of i.comments) out.push(`  - ${escapeMd(c)}`);
      }
      out.push("");
    }
    if (d.planned.length) {
      out.push("### Planned", "");
      for (const p of d.planned) out.push(`- ${hhmm(p.startsAt)}–${hhmm(p.endsAt)} ${p.kind}${p.issueKey ? ` ${p.issueKey}` : ""}${p.note ? `: ${escapeMd(p.note)}` : ""}`);
      out.push("");
    }
    if (d.mails.length) {
      out.push("### Mails pinned", "");
      for (const m of d.mails) out.push(`- ${escapeMd(m.subject || "(no subject)")}${m.fromName ? ` — ${escapeMd(m.fromName)}` : ""}${m.issueKey ? ` (${m.issueKey})` : ""}`);
      out.push("");
    }
  }
  return out.join("\n").trim();
}

const LANGUAGE: Record<string, string> = { en: "English", it: "Italian" };

/** What the model is asked to write from the days (the same text for Ollama and for "Copy for model"). */
export function diaryInstructions(mode: DiaryMode, locale: string, fromDay: string, toDay: string): string {
  const period = fromDay === toDay ? fromDay : `${fromDay} to ${toDay}`;
  const task =
    mode === "summary"
      ? `Write a report of the work from ${period}: the activities grouped by topic or client, the decisions taken, the open points and next steps, and the time spent where it helps. Use Markdown headings and short bullet lists.`
      : `Write a chronology of ${period}: one dated entry per day (newest last), each with what happened that day (meetings, decisions, work done, mails), in short bullet points.`;
  return [
    "You write documentation from a person's work diary: their notes, the time they logged per issue, their planned work and the mails they pinned.",
    task,
    "Use only facts present in the diary: never invent names, numbers, dates or outcomes. Keep issue keys (like APP-12) exactly as written.",
    `Write in ${LANGUAGE[locale] ?? "English"}.`,
  ].join(" ");
}
