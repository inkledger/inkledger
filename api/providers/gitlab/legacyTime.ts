// Time on a GitLab with no timelogs to read or write through GraphQL (13.x, and
// 14.x for writing): an entry is logged with the /spend quick action in a note,
// and GitLab records it as a system note ("added 1h 30m of time spent at
// 2026-10-21"). Those notes are the entries: the note's id is the entry's, the
// day is all the server keeps (no clock time), and an entry is removed by
// spending the same time back ("subtracted …"). A newer server reads and writes
// timelogs instead (adapter.ts); which one a server is comes from its schema.
import { instant, instantFrom } from "@contracts/values";
import { ProviderError } from "../core/errors";
import type { RemoteWorklog } from "../types";
import { gl, glPages, gql, type GitLabCreds, type GitLabIssue, type GitLabNote } from "./client";

/** What a server can do with time, read from its GraphQL schema. */
export type TimeMode = { readTimelogs: boolean; writeTimelogs: boolean };

const TIME_MODE = `query TimeMode { q: __type(name: "Query") { fields { name } } m: __type(name: "Mutation") { fields { name } } }`;
const MODE_TTL_MS = 3_600_000;
const modes = new Map<string, { mode: TimeMode; at: number }>();

/** Query.timelogs to read (GitLab 14+), Mutation.timelogCreate to write (15+); kept an hour per server. */
export async function timeModeOf(c: GitLabCreds, now = Date.now()): Promise<TimeMode> {
  const known = modes.get(c.apiBase);
  if (known && now - known.at < MODE_TTL_MS) return known.mode;
  type Fields = { fields: { name: string }[] | null } | null;
  const r = await gql<{ q: Fields; m: Fields }>(c, "TimeMode", TIME_MODE, {});
  const has = (t: Fields, name: string) => !!t?.fields?.some((f) => f.name === name);
  const mode = { readTimelogs: has(r.q, "timelogs"), writeTimelogs: has(r.m, "timelogCreate") && has(r.m, "timelogDelete") };
  modes.set(c.apiBase, { mode, at: now });
  return mode;
}

/** A server answered that a field isn't there: it changed (an upgrade, a downgrade), read its schema again. */
export const forgetTimeMode = (c: GitLabCreds) => void modes.delete(c.apiBase);

/** Entries read from notes carry this before the note's id, never mistaken for a timelog's. */
const PREFIX = "n";
export const isNoteEntry = (remoteId: string) => remoteId.startsWith(PREFIX);

// ---------- Durations ----------

/** GitLab's default conversion: a day is 8 hours, a week 5 days, a month 4 weeks. */
const UNIT_S: Record<string, number> = { mo: 4 * 5 * 8 * 3600, w: 5 * 8 * 3600, d: 8 * 3600, h: 3600, m: 60, s: 1 };

/** "1w 2d 3h 30m" (as GitLab writes it) in seconds; null when it isn't one. */
export function parseDuration(text: string): number | null {
  const parts = text.trim().split(/\s+/);
  let total = 0;
  for (const p of parts) {
    const m = /^(\d+)(mo|w|d|h|m|s)$/.exec(p);
    if (!m) return null;
    total += Number(m[1]) * UNIT_S[m[2]];
  }
  return parts.length ? total : null;
}

/** Seconds as /spend takes them, in hours, minutes and seconds only (a "day" would be 8 hours). */
export function spendDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join("") || "0m";
}

// ---------- Notes ----------

export type SpendNote =
  | { kind: "added" | "subtracted"; seconds: number; date: string | null }
  | { kind: "reset" };

/** A system note about time spent, or null. */
export function parseSpendNote(body: string): SpendNote | null {
  const text = body.trim();
  if (/^removed time spent\.?$/i.test(text)) return { kind: "reset" };
  const m = /^(added|subtracted) (.+?) of time spent(?: at (\d{4}-\d{2}-\d{2}))?\.?$/i.exec(text);
  if (!m) return null;
  const seconds = parseDuration(m[2]);
  return seconds === null ? null : { kind: m[1].toLowerCase() as "added" | "subtracted", seconds, date: m[3] ?? null };
}

/** The local day of an instant, as YYYY-MM-DD (the server runs in the user's zone, api/lib/tz.ts). */
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The clock time GitLab doesn't keep: the note's own when logged that day, else 9:00 (as for date-only services). */
function startOn(date: string, noteAt: number, seconds: number): number {
  if (localDay(noteAt) === date) return Math.max(new Date(`${date}T00:00:00`).getTime(), noteAt - seconds * 1000);
  return new Date(`${date}T09:00:00`).getTime();
}

const projectPathOf = (i: GitLabIssue) => i.references.full.slice(0, i.references.full.lastIndexOf("#"));

/**
 * The entries an issue's notes leave, oldest first: each "added" one, less those
 * a "subtracted" one of the same person, length and day took back (the latest
 * first), none before a "removed time spent".
 */
export function entriesOfNotes(i: GitLabIssue, notes: GitLabNote[]): RemoteWorklog[] {
  let live: { note: GitLabNote; seconds: number; date: string }[] = [];
  for (const n of [...notes].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)) {
    if (!n.system) continue;
    const s = parseSpendNote(n.body);
    if (!s) continue;
    if (s.kind === "reset") {
      live = [];
      continue;
    }
    const at = instantFrom(n.created_at) ?? 0;
    const date = s.date ?? localDay(at);
    if (s.kind === "added") {
      live.push({ note: n, seconds: s.seconds, date });
      continue;
    }
    let k = live.length - 1;
    while (k >= 0 && !(live[k].note.author.id === n.author.id && live[k].seconds === s.seconds && live[k].date === date)) k--;
    if (k >= 0) live.splice(k, 1);
  }
  const issue = { remoteId: String(i.id), key: i.references.full, container: { remoteId: String(i.project_id), key: projectPathOf(i) } };
  return live.map(({ note, seconds, date }) => ({
    remoteId: `${PREFIX}${note.id}`,
    issue,
    span: { kind: "session", start: instant(startOn(date, instantFrom(note.created_at) ?? 0, seconds)), seconds },
    comment: "",
    authorRemoteId: String(note.author.id),
    createdAt: instantFrom(note.created_at),
    updatedAt: null,
    dayOnly: true,
    editable: { update: false, delete: true },
  }));
}

const notesOf = (c: GitLabCreds, i: GitLabIssue) => glPages<GitLabNote>(c, `/projects/${i.project_id}/issues/${i.iid}/notes?sort=asc&order_by=created_at`);

export async function listByNotes(c: GitLabCreds, i: GitLabIssue): Promise<RemoteWorklog[]> {
  return entriesOfNotes(i, await notesOf(c, i));
}

const spend = (c: GitLabCreds, i: GitLabIssue, body: string) =>
  gl<unknown>(c, `/projects/${i.project_id}/issues/${i.iid}/notes`, { method: "POST", body: JSON.stringify({ body }), accept: [202], intent: "write" });

/**
 * Logs with /spend on the entry's day; a comment goes in the same note, above
 * the command (it stays as a comment). The entry is the system note GitLab
 * writes for it: the newest of this user's with that length and day.
 */
export async function createByNote(c: GitLabCreds, i: GitLabIssue, me: string, w: { seconds: number; start: number; comment: string }, safeText: (md: string) => string): Promise<RemoteWorklog> {
  const date = localDay(w.start);
  const before = new Set((await listByNotes(c, i)).map((e) => e.remoteId));
  const command = `/spend ${spendDuration(w.seconds)} ${date}`;
  await spend(c, i, w.comment.trim() ? `${safeText(w.comment.trim())}\n\n${command}` : command);
  const made = (await listByNotes(c, i)).filter((e) => !before.has(e.remoteId) && e.authorRemoteId === me && e.span.seconds === w.seconds && e.span.kind === "session" && localDay(e.span.start) === date).at(-1);
  if (!made) throw new ProviderError("incompatible", "GitLab took the /spend command but recorded no time (is time tracking on for this project?)");
  return { ...made, span: { kind: "session", start: instant(w.start), seconds: w.seconds }, comment: w.comment };
}

/** Spends the entry's time back on its day; an entry already gone is left so. */
export async function deleteByNote(c: GitLabCreds, i: GitLabIssue, remoteId: string): Promise<void> {
  const e = (await listByNotes(c, i)).find((x) => x.remoteId === remoteId);
  if (!e || e.span.kind !== "session") return;
  await spend(c, i, `/spend -${spendDuration(e.span.seconds)} ${localDay(e.span.start)}`);
}
