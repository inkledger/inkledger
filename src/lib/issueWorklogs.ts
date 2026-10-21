import { parseDayKey } from "@contracts/time";

/** Someone's entry on the issue, as its tracker lists it (worklogs.team). */
export type TeamEntry = {
  remoteId: string;
  /** A session's start (epoch ms), or null when the service keeps only the day */
  start: number | null;
  day: string | null;
  seconds: number;
  comment: string;
  authorName: string | null;
  mine: boolean;
};

/** A row of the issue's work log: one of mine (editable, local) or someone else's (read only). */
export type IssueLogRow<M> =
  | { kind: "mine"; at: number; log: M }
  | { kind: "other"; at: number; entry: TeamEntry };

const atOf = (e: TeamEntry) => e.start ?? (e.day ? parseDayKey(e.day)?.getTime() : undefined) ?? 0;

/**
 * My local worklogs and the others' from the tracker, newest first. Mine come
 * from here alone (they carry sync state and actions): a tracker entry that is
 * mine, or already one of my rows, is not repeated.
 */
export function mergeIssueWorklogs<M extends { remoteId: string; started: string | Date }>(
  mine: readonly M[],
  team: readonly TeamEntry[] | null | undefined,
): IssueLogRow<M>[] {
  const known = new Set(mine.map(w => w.remoteId));
  const rows: IssueLogRow<M>[] = [
    ...mine.map(log => ({ kind: "mine" as const, at: new Date(log.started).getTime(), log })),
    ...(team ?? [])
      .filter(e => !e.mine && !known.has(e.remoteId))
      .map(entry => ({ kind: "other" as const, at: atOf(entry), entry })),
  ];
  return rows.sort((a, b) => b.at - a.at);
}
