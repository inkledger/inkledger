import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { decisions, timers, type Decision, type Timer } from "@db/schema";
import { getDb } from "../queries/connection";
import { publish } from "../lib/userEvents";
import { stopSpan } from "@contracts/time";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Who acted: the page (x-client-id) and how its device is named. */
export type Actor = { client?: string; label: string };

const LIVE = ["open", "resolving"] as const;

const parse = (v: string): Record<string, unknown> => {
  try {
    const o: unknown = JSON.parse(v);
    return typeof o === "object" && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** A decision as every page shows it. */
export function viewOf(d: Decision) {
  return {
    id: d.id,
    kind: d.kind,
    state: d.state,
    revision: d.revision,
    payload: parse(d.payload),
    draft: parse(d.draft),
    draftBy: parse(d.draftBy),
    busy: d.state === "resolving" ? { label: d.busyLabel, until: d.busyUntil?.getTime() ?? 0 } : null,
    resolution: parse(d.resolution),
    createdAt: d.createdAt.getTime(),
    createdLabel: d.createdLabel,
  };
}

export type DecisionView = ReturnType<typeof viewOf>;

export const timerLogKey = (connectionId: number, issueKey: string) => `timer-log:${connectionId}:${issueKey}`;

/** Told to every page of the user, after the write that changed it. */
export function told(userId: number, d: Decision, origin?: string, fields?: string[]) {
  publish(userId, { type: "decisions", id: d.id, revision: d.revision, state: d.state, ...(fields ? { fields } : {}) }, origin);
}

/**
 * Asks to log a stopped timer, inside the timer write that stopped it (the
 * caller holds the user's timer lock, so the open one can't be raced). A
 * second stop of the same timer refreshes the open question, never a second.
 */
export async function openTimerLogIn(tx: Tx, t: Timer, at: { end: Date; seconds: number }, by: Actor): Promise<Decision> {
  const key = timerLogKey(t.connectionId, t.issueKey);
  const payload = JSON.stringify({ issueKey: t.issueKey, connectionId: t.connectionId, seconds: at.seconds, note: t.note, end: at.end.toISOString() });
  const premise = JSON.stringify({ timerId: t.id, epoch: t.epoch });
  const [open] = await tx.select().from(decisions).where(and(eq(decisions.userId, t.userId), eq(decisions.dedupeKey, key), inArray(decisions.state, [...LIVE])));
  if (open) {
    const [d] = await tx
      .update(decisions)
      .set({ payload, premise, revision: open.revision + 1, updatedAt: new Date() })
      .where(eq(decisions.id, open.id))
      .returning();
    return d;
  }
  const [d] = await tx.insert(decisions).values({ userId: t.userId, kind: "timer-log", dedupeKey: key, payload, premise, createdLabel: by.label }).returning();
  return d;
}

/**
 * The timer the open log question rests on moved on (resumed, discarded):
 * the question ends everywhere, with why.
 */
export async function endTimerLogIn(tx: Tx, userId: number, connectionId: number, issueKey: string, reason: string, by: Actor): Promise<Decision | null> {
  const [d] = await tx
    .update(decisions)
    .set({ state: "obsolete", resolution: JSON.stringify({ reason, by: by.label, client: by.client ?? "", at: Date.now() }), revision: sql`${decisions.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(decisions.userId, userId), eq(decisions.dedupeKey, timerLogKey(connectionId, issueKey)), eq(decisions.state, "open")))
    .returning();
  return d ?? null;
}

/** How long an answer may stay in flight before it counts as abandoned (a crash, a lost process). */
export const ANSWER_LEASE_MS = 120_000;
/** Answered or ended questions are kept this long (who answered, for pages back late), then purged. */
const KEEP_ENDED_MS = 7 * 86_400_000;

/**
 * An answer abandoned in flight (its process died between claim and finish)
 * opens the question again for everyone, with why. A timer's log whose timer
 * is gone was written (the time is taken only for a worklog): it ends as
 * logged instead, never asked twice.
 */
export async function reconcile(userId: number, now = new Date()) {
  const db = getDb();
  const stale = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.userId, userId), eq(decisions.state, "resolving"), lt(decisions.busyUntil, now)));
  for (const d of stale) {
    const p = parse(d.payload);
    const timerGone =
      d.kind === "timer-log" &&
      typeof p.issueKey === "string" &&
      typeof p.connectionId === "number" &&
      (await db.select({ id: timers.id }).from(timers).where(and(eq(timers.userId, userId), eq(timers.connectionId, p.connectionId), eq(timers.issueKey, p.issueKey)))).length === 0;
    const [next] = await db
      .update(decisions)
      .set({
        ...(timerGone ? { state: "obsolete", resolution: JSON.stringify({ reason: "logged" }) } : { state: "open", resolution: JSON.stringify({ lastError: "interrupted" }) }),
        busyBy: null,
        busyUntil: null,
        revision: sql`${decisions.revision} + 1`,
        updatedAt: now,
      })
      .where(and(eq(decisions.id, d.id), eq(decisions.state, "resolving")))
      .returning();
    if (next) told(userId, next);
  }
}

/** Ended questions past their keep, for everyone (at boot and daily). */
export async function purgeDecisions(now = Date.now()) {
  await getDb()
    .delete(decisions)
    .where(and(notInArray(decisions.state, [...LIVE]), lt(decisions.updatedAt, new Date(now - KEEP_ENDED_MS))));
}

/** The user's open questions, and the ones answered in the last few seconds (to say "decided elsewhere"). */
export async function listDecisions(userId: number): Promise<DecisionView[]> {
  await reconcile(userId);
  const since = new Date(Date.now() - 15_000);
  const rows = await getDb()
    .select()
    .from(decisions)
    .where(and(eq(decisions.userId, userId), sql`(${decisions.state} IN ('open','resolving') OR ${decisions.updatedAt} >= ${since.getTime()})`))
    .orderBy(desc(decisions.createdAt));
  return rows.map(viewOf);
}

/** A draft's whole size, every field together: each patch is bounded, so is what they add up to. */
const DRAFT_MAX_CHARS = 16_000;

/** Draft fields typed on one page, for all the others (last writer per field). */
export async function patchDraft(userId: number, id: string, fields: Record<string, unknown>, by: Actor) {
  const d = await getDb().transaction(async (tx) => {
    const [cur] = await tx.select().from(decisions).where(and(eq(decisions.id, id), eq(decisions.userId, userId))).for("update");
    if (!cur) throw new TRPCError({ code: "NOT_FOUND" });
    if (cur.state !== "open") return cur;
    const at = Date.now();
    const draft = { ...parse(cur.draft), ...fields };
    if (JSON.stringify(draft).length > DRAFT_MAX_CHARS) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "draft too large" });
    const draftBy = { ...parse(cur.draftBy), ...Object.fromEntries(Object.keys(fields).map((k) => [k, { client: by.client ?? "", at }])) };
    const [next] = await tx
      .update(decisions)
      // The revision is the question's (asked, refreshed, answered), not its typing: an
      // answer sent right after a keystroke on another page still stands.
      .set({ draft: JSON.stringify(draft), draftBy: JSON.stringify(draftBy), updatedAt: new Date() })
      .where(eq(decisions.id, id))
      .returning();
    return next;
  });
  if (d.state === "open") told(userId, d, by.client, Object.keys(fields));
  return { revision: d.revision, state: d.state };
}

/** Why an answer was refused: answered elsewhere, being answered, or changed since this page saw it. */
function conflict(cur: Decision | undefined): never {
  // Not this user's (or gone): as for anything else of someone else's, nothing is told.
  if (!cur) throw new TRPCError({ code: "NOT_FOUND" });
  const reason = cur.state === "resolving" ? "busy" : cur.state === "open" ? "changed" : "decided";
  throw new TRPCError({ code: "CONFLICT", message: `decision:${reason}`, cause: new Error(JSON.stringify({ reason, decision: cur ? viewOf(cur) : null })) });
}

/**
 * First answer wins: the decision is claimed (open → resolving at the
 * revision the page saw) before the action, so a second page answering the
 * same question is refused and nothing is written twice. Then `run` acts:
 * done → resolved; failed → open again with the error, for every page.
 */
export async function answer<T>(userId: number, ref: { id: string; revision: number }, by: Actor, choice: string, run: (claimed: Decision) => Promise<T>, resultOf: (r: T) => Record<string, unknown> = () => ({})): Promise<T> {
  const db = getDb();
  const [claimed] = await db
    .update(decisions)
    .set({ state: "resolving", busyBy: by.client ?? "?", busyLabel: by.label, busyUntil: new Date(Date.now() + ANSWER_LEASE_MS), revision: sql`${decisions.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(decisions.id, ref.id), eq(decisions.userId, userId), eq(decisions.state, "open"), eq(decisions.revision, ref.revision)))
    .returning();
  if (!claimed) {
    const [cur] = await db.select().from(decisions).where(and(eq(decisions.id, ref.id), eq(decisions.userId, userId)));
    conflict(cur);
  }
  told(userId, claimed, by.client);
  let r: T;
  try {
    r = await run(claimed);
  } catch (e) {
    const [back] = await db
      .update(decisions)
      .set({ state: "open", busyBy: null, busyUntil: null, resolution: JSON.stringify({ lastError: e instanceof Error ? e.message : String(e) }), revision: sql`${decisions.revision} + 1`, updatedAt: new Date() })
      // Only this claim: one taken over after its lease ran out (reconciled, claimed again) is not this answer's to reopen.
      .where(and(eq(decisions.id, ref.id), eq(decisions.state, "resolving"), eq(decisions.revision, claimed.revision)))
      .returning();
    if (back) told(userId, back, by.client);
    throw e;
  }
  const [done] = await db
    .update(decisions)
    .set({ state: "resolved", busyBy: null, busyUntil: null, resolution: JSON.stringify({ choice, by: by.label, client: by.client ?? "", at: Date.now(), ...resultOf(r) }), revision: sql`${decisions.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(decisions.id, ref.id), eq(decisions.state, "resolving"), eq(decisions.revision, claimed.revision)))
    .returning();
  if (done) told(userId, done, by.client);
  return r;
}

/**
 * "Later": the question closes everywhere; the paused timer stays to log,
 * with the comment typed so far as its note (the next opening has it back).
 */
export async function dismiss(userId: number, ref: { id: string; revision: number }, by: Actor) {
  return answer(userId, ref, by, "later", async (d) => {
    const draft = parse(d.draft);
    const p = parse(d.payload);
    if (d.kind !== "timer-log" || typeof draft.comment !== "string" || typeof p.issueKey !== "string" || typeof p.connectionId !== "number") return { noted: false };
    const kept = await getDb()
      .update(timers)
      .set({ note: draft.comment.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(timers.userId, userId), eq(timers.connectionId, p.connectionId), eq(timers.issueKey, p.issueKey)))
      .returning({ epoch: timers.epoch });
    if (kept[0]) publish(userId, { type: "timers", epoch: kept[0].epoch }, by.client);
    return { noted: kept.length > 0 };
  });
}

/**
 * Asks again to log a stopped timer (its "to log" button, its block on the
 * timeline): the open question if there is one, else a new one on every page.
 */
export async function askTimerLogIn(tx: Tx, t: Timer, by: Actor): Promise<Decision> {
  return openTimerLogIn(tx, t, stopSpan(t.pausedAt ?? t.updatedAt, t.accumulatedSeconds), by);
}
