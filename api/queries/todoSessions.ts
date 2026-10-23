// Time on a TODO, beside the real time (todo_sessions): one stretch open at a
// time per user. Written inside the timer lock's transaction by the timer
// actions (a linked stretch ends when its issue's timer stops) and by the TODO
// list's own start and stop.
import { and, eq, isNull, sql } from "drizzle-orm";
import { todoSessions } from "@db/schema";
import { startOfDay } from "@contracts/time";
import type { getDb } from "./connection";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const openOf = (userId: number) => and(eq(todoSessions.userId, userId), isNull(todoSessions.endedAt));

/** The open stretch of the user, if any. */
export async function openSession(db: Db | Tx, userId: number) {
  const [row] = await db.select().from(todoSessions).where(openOf(userId)).limit(1);
  return row;
}

/**
 * Ends the open stretch at `at` (never before it began). `linked`: only a
 * stretch tied to an issue timer (a timer stopping), only one with none (an
 * issue timer starting, which takes the focus), or either.
 */
export async function endSession(db: Db | Tx, userId: number, at: Date, linked?: boolean) {
  const which = linked === undefined ? undefined : eq(todoSessions.linked, linked ? 1 : 0);
  await db
    .update(todoSessions)
    .set({ endedAt: sql`greatest(${todoSessions.startedAt}, ${at.getTime()})` })
    .where(and(openOf(userId), which));
}

/** A new stretch on a TODO from `at`; whatever was open ends there first. */
export async function beginSession(db: Db | Tx, userId: number, todo: { id: number; text: string }, linked: boolean, at: Date) {
  await endSession(db, userId, at);
  await db.insert(todoSessions).values({ userId, todoId: todo.id, label: todo.text, linked: linked ? 1 : 0, startedAt: at });
}

/**
 * Away time taken out of a running linked stretch (the timer's idle trim):
 * it ends where the user left and a new one starts now, so the TODO's time
 * leaves the same hole as the timer's.
 */
export async function trimSession(db: Db | Tx, userId: number, seconds: number, now: Date) {
  const open = await openSession(db, userId);
  if (!open || open.linked !== 1) return;
  await endSession(db, userId, new Date(now.getTime() - seconds * 1000));
  if (open.todoId !== null) await db.insert(todoSessions).values({ userId, todoId: open.todoId, label: open.label, linked: 1, startedAt: now });
}

/**
 * A stretch with no timer left open from an earlier day (forgotten overnight)
 * ends at that day's end: it never runs on into today.
 */
export async function closeStaleSession(db: Db | Tx, userId: number, now: Date) {
  const open = await openSession(db, userId);
  if (!open || open.linked === 1) return;
  const today = startOfDay(now);
  if (open.startedAt.getTime() >= today.getTime()) return;
  const dayEnd = new Date(startOfDay(open.startedAt).getTime() + 24 * 3600_000 - 1);
  await endSession(db, userId, dayEnd);
}
