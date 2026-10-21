import { companionOf, markForSinks, queueSinkDeletes, sinksSoon } from "../sync/extraSinks";
import { companionEntry, createViaCompanion, deleteViaCompanion, updateViaCompanion } from "../sync/companion";
import { ProviderError } from "../providers/core/errors";
import { worklogScope } from "../queries/worklogScope";
import type { RemoteSnapshot } from "../sync/worklogs";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, getTableColumns, gte, inArray, isNotNull, like, lt, not, notInArray, type SQL } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { randomUUID } from "node:crypto";
import { outbox, worklogs, worklogSinks, worklogTrash, type Connection, type User } from "@db/schema";
import type { TrackerType } from "@contracts/providers";
import {
  fetchWorklogs,
  isAuthor,
  isNetworkError,
  textFromAdf,
  type JiraWorklog,
} from "../jira/client";
import {
  MAX_WORKLOG_SECONDS,
  parseDurationToSeconds,
} from "@contracts/time";
import { assertWeekOpen } from "./weeks";
import { conflictMessage, overlapping } from "@contracts/placement";
import { claimTimerSeconds } from "./timers";
import { withOutboxLock } from "./outbox";
import { getSettings } from "./settings";
import { TRASH_DAYS, withDeleteReason } from "../queries/trash";
import { syncWorklogs } from "../worklogSync";
import { issueKeyInput, LIST_MAX_ROWS } from "../lib/inputs";
import { t } from "@contracts/i18n";
import { contextFor, issueConnection } from "../providers/connections";
import { trackerAdapter } from "../providers/registry";
import { contractTime, createThrough, deleteThrough, updateThrough } from "../sync/timeWrites";

const timeFields = {
  /** Whole seconds: what the app sends (a typed "1d" is resolved on the device, by the work schedule) */
  seconds: z.number().int().positive().max(MAX_WORKLOG_SECONDS).optional(),
  /** Older apps: a Jira-style duration, e.g. "2h 30m", "45m" (accepted for one more release) */
  timeSpent: z.string().min(1).max(40).optional(),
  /** Instant with its offset (a bare date would be read as UTC midnight) */
  started: z.iso.datetime({ offset: true }),
  comment: z.string().max(10_000).default(""),
};
const hasDuration = (v: { seconds?: number; timeSpent?: string }) => v.seconds !== undefined || v.timeSpent !== undefined;

/** A worklog by its id in inkledger, or (older apps) by its issue and its id on the tracker. */
const worklogRefFields = {
  id: z.number().int().positive().optional(),
  /** With issueKey and remoteId: which connection (a key on two) */
  connectionId: z.number().int().positive().optional(),
  issueKey: issueKeyInput.optional(),
  remoteId: z.string().min(1).max(64).optional(),
  /** Older apps' name for remoteId (accepted for one more release, T9) */
  jiraWorklogId: z.string().min(1).max(64).optional(),
};
const hasRef = (v: { id?: number; issueKey?: string; remoteId?: string; jiraWorklogId?: string }) =>
  v.id !== undefined || (v.issueKey !== undefined && (v.remoteId ?? v.jiraWorklogId) !== undefined);

/** The issue and tracker id of a worklog named either way (one of the user's own). */
async function worklogRef(
  userId: number,
  ref: { id?: number; issueKey?: string; remoteId?: string; jiraWorklogId?: string; connectionId?: number },
): Promise<{ issueKey: string; remoteId: string; connectionId?: number }> {
  if (ref.id === undefined) return { issueKey: ref.issueKey ?? "", remoteId: ref.remoteId ?? ref.jiraWorklogId ?? "", connectionId: ref.connectionId };
  const [row] = await getDb()
    .select({ issueKey: worklogs.issueKey, remoteId: worklogs.remoteId, connectionId: worklogs.connectionId })
    .from(worklogs)
    .where(and(eq(worklogs.userId, userId), eq(worklogs.id, ref.id)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.worklogs.notFound") });
  return row;
}

/** Local placeholder id for worklogs queued in the offline outbox. */
export const PENDING_PREFIX = "pending-";

export function isPendingId(remoteId: string): boolean {
  return remoteId.startsWith(PENDING_PREFIX);
}

/** Id of a worklog kept only in inkledger: its tracker keeps no time (GitHub). */
export const LOCAL_PREFIX = "local-";

export function isLocalId(remoteId: string): boolean {
  return remoteId.startsWith(LOCAL_PREFIX);
}

/** The tracker keeps no time of its own: inkledger is where its worklogs live. */
function keepsTimeLocally(conn: Pick<Connection, "type">): boolean {
  return trackerAdapter(conn.type as TrackerType)?.capabilities.time.mode === "local";
}

/**
 * A pending worklog can be edited only while its create is still queued: once replayed it
 * has a real Jira id, and an edit by the old id would silently do nothing.
 */
async function assertStillQueued(userId: number, outboxId: number) {
  const queued = (await getDb()
    .select({ id: outbox.id })
    .from(outbox)
    .where(and(eq(outbox.id, outboxId), eq(outbox.userId, userId))).limit(1))[0];
  if (!queued) {
    throw new TRPCError({
      code: "CONFLICT",
      message: t("server.worklogs.justSynced"),
    });
  }
}

export function pendingOutboxId(remoteId: string): number {
  return parseInt(remoteId.slice(PENDING_PREFIX.length), 10);
}

export { isNetworkError };

/** Worklog authored by the given user (Cloud: accountId, Server/DC: name or key). */
export function isAuthoredBy(w: JiraWorklog, accountId: string): boolean {
  return isAuthor(w.author, accountId);
}

/** One write at a time per user: two parallel requests can't both pass the overlap check. */
const writeLocks = new Map<number, Promise<unknown>>();
function withWriteLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const run = (writeLocks.get(userId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  writeLocks.set(userId, tail);
  void tail.then(() => {
    if (writeLocks.get(userId) === tail) writeLocks.delete(userId);
  });
  return run;
}

/**
 * With the "block" policy, time is never logged twice: refuse a block that
 * covers another worklog of the user (local copy: last sync plus what the
 * app logged).
 */
async function assertNoOverlap(
  userId: number,
  block: { start: Date; seconds: number },
  exceptId?: string,
): Promise<void> {
  // Parallel work is allowed by default (D12): only "block" refuses it; the app warns.
  if ((await getSettings(userId)).overlapPolicy !== "block") return;
  const from = new Date(block.start.getTime() - MAX_WORKLOG_SECONDS * 1000);
  const to = new Date(block.start.getTime() + block.seconds * 1000);
  const near = await getDb()
    .select({
      id: worklogs.remoteId,
      issueKey: worklogs.issueKey,
      started: worklogs.started,
      seconds: worklogs.timeSpentSeconds,
    })
    .from(worklogs)
    .where(and(eq(worklogs.userId, userId), gte(worklogs.started, from), lt(worklogs.started, to)));
  const hits = overlapping(
    block,
    near.map((w) => ({ start: w.started, seconds: w.seconds, id: w.id, label: w.issueKey })),
    exceptId,
  );
  if (hits.length > 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: t("server.worklogs.overlapHint", { message: conflictMessage(hits) }),
    });
  }
}

function parseLogInput(input: { seconds?: number; timeSpent?: string; started: string }) {
  const seconds = input.seconds ?? parseDurationToSeconds(input.timeSpent ?? "");
  if (!seconds || seconds <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: t("server.worklogs.invalidDuration", { value: input.timeSpent ?? String(input.seconds) }),
    });
  }
  // Jira rejects worklogs under a minute with a bare 400.
  if (seconds < 60) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: t("server.worklogs.minDuration"),
    });
  }
  if (seconds > MAX_WORKLOG_SECONDS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: t("server.worklogs.maxDuration"),
    });
  }
  const started = new Date(input.started);
  if (isNaN(started.getTime())) {
    throw new TRPCError({ code: "BAD_REQUEST", message: t("server.worklogs.invalidStart") });
  }
  return { seconds, started };
}

export function rowFromJira(
  userId: number,
  issueKey: string,
  w: JiraWorklog,
  /** Its connection, when known (with several, the database can't always tell) */
  connectionId?: number,
) {
  return {
    userId,
    ...(connectionId !== undefined ? { connectionId } : {}),
    issueKey,
    remoteId: w.id,
    timeSpentSeconds: w.timeSpentSeconds,
    started: new Date(w.started),
    comment: textFromAdf(w.comment).trim(),
    authorAccountId: w.author?.accountId ?? w.author?.name ?? w.author?.key ?? "",
    remoteCreated: w.created ?? null,
    remoteUpdated: w.updated ?? null,
    syncedAt: new Date(),
  };
}

export async function upsertLocal(row: ReturnType<typeof rowFromJira>) {
  const db = getDb();
  const saved = await db
    .insert(worklogs)
    .values(row)
    .onConflictDoUpdate({
      target: [worklogs.userId, worklogs.connectionId, worklogs.issueKey, worklogs.remoteId],
      set: row,
    })
    .returning();
  return saved[0];
}

/** A worklog by issue and remote id, on its connection when known (a key may live on two). */
function worklogWhere(userId: number, issueKey: string, remoteId: string, connectionId?: number) {
  return and(
    eq(worklogs.userId, userId),
    eq(worklogs.issueKey, issueKey),
    eq(worklogs.remoteId, remoteId),
    ...(connectionId !== undefined ? [eq(worklogs.connectionId, connectionId)] : []),
  );
}

async function updateLocalWorklog(
  userId: number,
  issueKey: string,
  remoteId: string,
  fields: { timeSpentSeconds: number; started: Date; comment: string },
  connectionId?: number,
) {
  const saved = await getDb().update(worklogs).set(fields).where(worklogWhere(userId, issueKey, remoteId, connectionId)).returning();
  return saved[0];
}

/** The user's own delete: the worklog goes to the trash as such. */
async function deleteLocalWorklog(userId: number, issueKey: string, remoteId: string, connectionId?: number) {
  await withDeleteReason("user", (db) => db.delete(worklogs).where(worklogWhere(userId, issueKey, remoteId, connectionId)));
}



/**
 * Log time on the issue's tracker and store the worklog locally. A tracker
 * that keeps no time (GitHub) never sees it: the worklog lives in inkledger.
 * Any other goes through the provider contract: if its tracker is
 * unreachable the operation is queued in the outbox and the worklog is
 * stored locally with a "pending-N" placeholder id.
 */
async function createWorklog(
  account: User,
  input: { issueKey: string; comment: string; connectionId?: number },
  seconds: number,
  started: Date,
) {
  const conn = await issueConnection(account.id, input.issueKey, input.connectionId);
  if (keepsTimeLocally(conn)) {
    const [row] = await getDb()
      .insert(worklogs)
      .values({
        userId: account.id,
        connectionId: conn.id,
        issueKey: input.issueKey,
        remoteId: `${LOCAL_PREFIX}${randomUUID()}`,
        timeSpentSeconds: seconds,
        started,
        comment: input.comment,
        authorAccountId: conn.remoteAccountId,
        remoteCreated: null,
        remoteUpdated: null,
        syncedAt: new Date(),
      })
      .returning();
    return row;
  }
  // A time sink standing in for the tracker (Tempo for its Jira): filed there.
  const companion = await companionOf(conn);
  if (companion) return createViaCompanion(companion, conn, { userId: account.id, issueKey: input.issueKey, seconds, started, comment: input.comment });
  // Any other tracker that keeps entries: through the provider contract.
  const through = await contractTime(account.id, conn, input.issueKey);
  if (!through) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.worklogs.noTimeHere") });
  return createThrough(through, { userId: account.id, issueKey: input.issueKey, seconds, started, comment: input.comment });
}

const parseJson = <T>(raw: string | null | undefined): T | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

/** Locked on its service (approved, invoiced, period closed…): changed there only (D13). */
async function assertUnlocked(where: SQL | undefined) {
  const [row] = await getDb()
    .select({ locked: worklogSinks.locked })
    .from(worklogs)
    .innerJoin(worklogSinks, eq(worklogSinks.worklogId, worklogs.id))
    .where(and(where, isNotNull(worklogSinks.locked)))
    .limit(1);
  const lock = parseJson<{ cause: string; message?: string }>(row?.locked);
  if (lock) throw new TRPCError({ code: "FORBIDDEN", message: lock.message ? t("server.worklogs.lockedBecause", { reason: lock.message }) : t("server.worklogs.locked") });
}

const timeMeta = () => ({ signal: AbortSignal.timeout(30_000), correlationId: `time-${Date.now()}` });

export const worklogsRouter = createRouter({
  /**
   * A worklog changed here and on its tracker: keep this one (sent to the
   * tracker, over its version) or take the tracker's.
   */
  resolveConflict: protectedProcedure
    .input(z.object({ id: z.number().int().positive(), keep: z.enum(["mine", "theirs"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [row] = await db.select().from(worklogs).where(and(eq(worklogs.id, input.id), eq(worklogs.userId, ctx.user.id)));
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.worklogs.notFound") });
      const [sink] = await db.select().from(worklogSinks).where(and(eq(worklogSinks.worklogId, row.id), eq(worklogSinks.state, "conflict")));
      const remote = parseJson<RemoteSnapshot>(sink?.remoteSnapshot);
      if (!sink || !remote) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.worklogs.noConflict") });
      return withWriteLock(ctx.user.id, async () => {
        if (input.keep === "theirs") {
          await db.update(worklogs).set({ timeSpentSeconds: remote.seconds, started: new Date(remote.started), comment: remote.comment, syncedAt: new Date() }).where(eq(worklogs.id, row.id));
          await db.delete(outbox).where(and(eq(outbox.worklogId, row.id), eq(outbox.connectionId, sink.sinkConnectionId)));
          await db.update(worklogSinks).set({ state: "synced", remoteSnapshot: null, lastError: null }).where(eq(worklogSinks.id, sink.id));
        } else {
          const conn = await issueConnection(ctx.user.id, row.issueKey, sink.sinkConnectionId);
          const through = await contractTime(ctx.user.id, conn, row.issueKey);
          if (!through) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.worklogs.noConflict") });
          await db.update(worklogSinks).set({ state: "pending", remoteSnapshot: null }).where(eq(worklogSinks.id, sink.id));
          await updateThrough(through, row, { timeSpentSeconds: row.timeSpentSeconds, started: row.started, comment: row.comment });
        }
        const [after] = await db.select().from(worklogs).where(eq(worklogs.id, row.id));
        return after;
      });
    }),

  /** List local worklogs, optionally filtered by issue or date range. */
  list: protectedProcedure
    .input(
      z
        .object({
          issueKey: issueKeyInput.optional(),
          /** The issue's connection (a key may be on two trackers) */
          connectionId: z.number().int().positive().optional(),
          from: z.iso.datetime({ offset: true }).optional(),
          to: z.iso.datetime({ offset: true }).optional(),
          /**
           * D9: the Timesheet's bucket, or all the time (the default: the
           * day's gaps, placement and overlap always read everything)
           */
          scope: z.enum(["bucket", "all"]).default("all"),
          /** The search language, on the worklogs' issues */
          search: z.string().trim().max(500).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const conds = [eq(worklogs.userId, ctx.user.id), ...(input ? (await worklogScope(ctx.user.id, ctx.deviceId, input)).where : [])];
      if (input?.issueKey) conds.push(eq(worklogs.issueKey, input.issueKey));
      if (input?.connectionId) conds.push(eq(worklogs.connectionId, input.connectionId));
      if (input?.from) conds.push(gte(worklogs.started, new Date(input.from)));
      // `to` is exclusive (callers pass the start of the next period).
      if (input?.to) conds.push(lt(worklogs.started, new Date(input.to)));
      // With where it stands on its own tracker: synced, waiting, in conflict, locked there.
      const rows = await db
        .select({ ...getTableColumns(worklogs), sinkState: worklogSinks.state, sinkLocked: worklogSinks.locked, sinkRemote: worklogSinks.remoteSnapshot, sinkError: worklogSinks.lastError })
        .from(worklogs)
        .leftJoin(worklogSinks, and(eq(worklogSinks.worklogId, worklogs.id), eq(worklogSinks.sinkConnectionId, worklogs.connectionId)))
        .where(and(...conds))
        .orderBy(desc(worklogs.started))
        .limit(LIST_MAX_ROWS);
      return rows.map(({ sinkState, sinkLocked, sinkRemote, sinkError, ...w }) => ({
        ...w,
        sink: {
          state: (sinkState ?? null) as "synced" | "pending" | "failed" | "conflict" | null,
          locked: parseJson<{ cause: string; message?: string }>(sinkLocked),
          remote: parseJson<RemoteSnapshot>(sinkRemote),
          error: sinkError ?? null,
        },
      }));
    }),

  /**
   * Everyone's time on one issue, live from its tracker: mine marked, the
   * others' with their author. Null where the tracker keeps no entries (all
   * the time is here, and mine) or can't list them.
   */
  team: protectedProcedure
    .input(z.object({ issueKey: issueKeyInput, connectionId: z.number().int().positive().optional() }))
    .query(async ({ ctx, input }) => {
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      if (keepsTimeLocally(conn)) return null;
      const through = await contractTime(ctx.user.id, conn, input.issueKey);
      if (!through?.b.worklogs?.list) return null;
      const remote = await through.b.worklogs.list({ signal: AbortSignal.timeout(30_000), correlationId: `team-${Date.now()}` }, through.ref);
      const entries = remote.map((w) => ({
        remoteId: w.remoteId,
        // A session's start, or the day alone (services keeping only the date)
        start: w.span.kind === "session" ? (w.span.start as number) : null,
        day: w.span.kind === "session" ? null : (w.span.date as string),
        seconds: w.span.seconds,
        comment: w.comment,
        authorName: w.authorName ?? null,
        mine: w.authorRemoteId === conn.remoteAccountId,
      }));
      return { entries, totalSeconds: entries.reduce((acc, e) => acc + e.seconds, 0) };
    }),

  /** Settings → Account: import the last 12 months of my worklogs from Jira again. */
  reimport: protectedProcedure.mutation(({ ctx }) => syncWorklogs(ctx.user, { reimport: true })),

  /** Pull worklogs of one issue from Jira and upsert locally. */
  syncIssue: protectedProcedure
    .input(z.object({ issueKey: issueKeyInput, connectionId: z.number().int().positive().optional() }))
    .mutation(async ({ ctx, input }) => {
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      // Its tracker keeps no time: inkledger already has them all.
      if (keepsTimeLocally(conn)) return { synced: 0 };
      const { user, creds } = contextFor(ctx.user, conn);
      const remote = await fetchWorklogs(creds, input.issueKey);
      const db = getDb();
      // Queued offline edits/deletes win over Jira's (older) copy until replayed:
      // re-importing it would resurrect a deleted worklog or undo an edit.
      const queued = new Set(
        (
          await db
            .select({ id: outbox.remoteId })
            .from(outbox)
            .where(
              and(
                eq(outbox.userId, ctx.user.id),
                eq(outbox.connectionId, user.connectionId),
                eq(outbox.issueKey, input.issueKey),
                inArray(outbox.kind, ["update", "delete"]),
              ),
            )
        ).map((o) => o.id),
      );
      const mine = remote.filter((w) => isAuthoredBy(w, user.accountId));
      for (const w of mine) {
        if (queued.has(w.id)) continue;
        await upsertLocal(rowFromJira(ctx.user.id, input.issueKey, w, user.connectionId));
      }
      // Drop local copies of worklogs deleted on Jira (pending ones stay queued).
      const keep = mine.map((w) => w.id);
      await db
        .delete(worklogs)
        .where(
          and(
            eq(worklogs.userId, ctx.user.id),
            eq(worklogs.connectionId, user.connectionId),
            eq(worklogs.issueKey, input.issueKey),
            not(like(worklogs.remoteId, `${PENDING_PREFIX}%`)),
            ...(keep.length > 0 ? [notInArray(worklogs.remoteId, keep)] : []),
          ),
        );
      return { synced: mine.length };
    }),

  /** Log time (queued offline when its tracker is unreachable). */
  create: protectedProcedure
    .input(
      z
        .object({
          issueKey: issueKeyInput,
          connectionId: z.number().int().positive().optional(),
          ...timeFields,
          /** Logging the time of a stopped timer: clear it once saved (if still stopped). */
          fromTimer: z.boolean().default(false),
        })
        .refine(hasDuration, "seconds or timeSpent"),
    )
    .mutation(async ({ ctx, input }) => {
      const { seconds, started } = parseLogInput(input);
      await assertWeekOpen(ctx.user.id, started);
      return withWriteLock(ctx.user.id, async () => {
        await assertNoOverlap(ctx.user.id, { start: started, seconds });
        // A timer's time is logged once: it is taken under the database lock
        // before the worklog is written, so two devices logging it at once
        // can't both succeed (gone means another flow logged it). A stopped
        // timer is cleared; one restarted meanwhile keeps running minus this
        // time. If the worklog then fails, the time goes back to the timer.
        const claim = input.fromTimer ? await claimTimerSeconds(ctx.user.id, input.issueKey, seconds, input.connectionId) : null;
        if (input.fromTimer && !claim) {
          throw new TRPCError({ code: "CONFLICT", message: t("server.worklogs.timerLogged", { key: input.issueKey }) });
        }
        const saved = await createWorklog(ctx.user, input, seconds, started).catch(async (e: unknown) => {
          await claim?.undo();
          throw e;
        });
        // Its time goes to the user's time sinks too, in the background.
        await markForSinks(ctx.user.id, saved.id);
        sinksSoon(ctx.user.id);
        return saved;
      });
    }),

  update: protectedProcedure
    .input(z.object({ ...worklogRefFields, ...timeFields }).refine(hasDuration, "seconds or timeSpent").refine(hasRef, "id, or issueKey and remoteId"))
    .mutation(async ({ ctx, input: given }) => {
      const input = { ...given, ...(await worklogRef(ctx.user.id, given)) };
      const { seconds, started } = parseLogInput(input);
      await assertWeekOpen(ctx.user.id, started);
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      const where = worklogWhere(ctx.user.id, input.issueKey, input.remoteId, conn.id);
      // Moving a worklog out of a locked week is an edit of that week too.
      const [current] = await getDb()
        .select({ started: worklogs.started, seconds: worklogs.timeSpentSeconds })
        .from(worklogs)
        .where(where);
      if (current) await assertWeekOpen(ctx.user.id, current.started);
      await assertUnlocked(where);
      // Only a change of time is checked: a comment on a worklog that already
      // overlaps (as it came from Jira) stays editable.
      const moved =
        !current ||
        current.started.getTime() !== started.getTime() ||
        current.seconds !== seconds;
      // Check and save under one lock, as in create: two writes can't both pass.
      // With what it was (host events tell how much the logged time moved).
      const previousSeconds = current?.seconds ?? null;
      const saved = await withWriteLock(ctx.user.id, async () => {
        if (moved) {
          await assertNoOverlap(ctx.user.id, { start: started, seconds }, input.remoteId);
        }
        const fields = { timeSpentSeconds: seconds, started, comment: input.comment };
        // Kept only in inkledger: nothing to tell a tracker.
        if (isLocalId(input.remoteId)) {
          return await updateLocalWorklog(ctx.user.id, input.issueKey, input.remoteId, fields, conn.id);
        }
        // Pending worklog: it never reached its tracker — just update the local copy
        // and the queued "create" operation.
        if (isPendingId(input.remoteId)) {
          const oid = pendingOutboxId(input.remoteId);
          return await withOutboxLock(ctx.user.id, async () => {
            await assertStillQueued(ctx.user.id, oid);
            await getDb()
              .update(outbox)
              .set(fields)
              .where(and(eq(outbox.id, oid), eq(outbox.userId, ctx.user.id)));
            return await updateLocalWorklog(ctx.user.id, input.issueKey, input.remoteId, fields, conn.id);
          });
        }
        const [row] = await getDb().select().from(worklogs).where(where);
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.worklogs.notFound") });
        // Filed through a sink standing in for its tracker: changed there.
        const filed = await companionEntry(row);
        if (filed) return await updateViaCompanion(filed, row, fields);
        const through = await contractTime(ctx.user.id, conn, input.issueKey);
        if (!through) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.worklogs.noTimeHere") });
        return await updateThrough(through, row, fields);
      });
      await markForSinks(ctx.user.id, saved.id);
      sinksSoon(ctx.user.id);
      return { ...saved, previousSeconds };
    }),

  /** Worklogs deleted in the last 30 days (by the user, or gone from their service), newest first. */
  trash: protectedProcedure.query(async ({ ctx }) =>
    getDb()
      .select()
      .from(worklogTrash)
      .where(and(eq(worklogTrash.userId, ctx.user.id), gte(worklogTrash.deletedAt, new Date(Date.now() - TRASH_DAYS * 86_400_000))))
      .orderBy(desc(worklogTrash.deletedAt))
      .limit(LIST_MAX_ROWS),
  ),

  /**
   * A worklog back from the trash: logged again like a new one (its week
   * open, no overlap), so it gets a new id on the service.
   */
  restore: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const [item] = await db
      .select()
      .from(worklogTrash)
      .where(and(eq(worklogTrash.id, input.id), eq(worklogTrash.userId, ctx.user.id)))
      .limit(1);
    if (!item) throw new TRPCError({ code: "NOT_FOUND", message: t("server.worklogs.notFound") });
    await assertWeekOpen(ctx.user.id, item.started);
    return withWriteLock(ctx.user.id, async () => {
      await assertNoOverlap(ctx.user.id, { start: item.started, seconds: item.timeSpentSeconds });
      const saved = await createWorklog(ctx.user, { issueKey: item.issueKey, comment: item.comment, connectionId: item.connectionId ?? undefined }, item.timeSpentSeconds, item.started);
      await db.delete(worklogTrash).where(eq(worklogTrash.id, item.id));
      return saved;
    });
  }),

  delete: protectedProcedure
    .input(z.object(worklogRefFields).refine(hasRef, "id, or issueKey and remoteId"))
    .mutation(async ({ ctx, input: given }) => {
      const input = await worklogRef(ctx.user.id, given);
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      const db = getDb();
      // The lock is driven by the worklog's own week, not the current one.
      const local = await db
        .select({ started: worklogs.started, seconds: worklogs.timeSpentSeconds })
        .from(worklogs)
        .where(worklogWhere(ctx.user.id, input.issueKey, input.remoteId, conn.id));
      if (local[0]) {
        await assertWeekOpen(ctx.user.id, local[0].started);
      }
      await assertUnlocked(worklogWhere(ctx.user.id, input.issueKey, input.remoteId, conn.id));
      // Its entries on the time sinks go too (queued now: its rows go with it).
      const [whole] = await db.select().from(worklogs).where(worklogWhere(ctx.user.id, input.issueKey, input.remoteId, conn.id));
      if (whole) {
        await queueSinkDeletes(whole);
        sinksSoon(ctx.user.id);
      }
      // Kept only in inkledger: it goes to the trash, no tracker to tell.
      if (isLocalId(input.remoteId)) {
        await deleteLocalWorklog(ctx.user.id, input.issueKey, input.remoteId, conn.id);
        return { ok: true, seconds: local[0]?.seconds ?? null, issueKey: input.issueKey, connectionId: conn.id };
      }
      // Pending worklog: drop the queued operation, nothing to tell its tracker.
      if (isPendingId(input.remoteId)) {
        const oid = pendingOutboxId(input.remoteId);
        return await withOutboxLock(ctx.user.id, async () => {
          await assertStillQueued(ctx.user.id, oid);
          await getDb()
            .delete(outbox)
            .where(and(eq(outbox.id, oid), eq(outbox.userId, ctx.user.id)));
          await deleteLocalWorklog(ctx.user.id, input.issueKey, input.remoteId, conn.id);
          return { ok: true, seconds: local[0]?.seconds ?? null, issueKey: input.issueKey, connectionId: conn.id };
        });
      }
      const [filedRow] = await db.select().from(worklogs).where(worklogWhere(ctx.user.id, input.issueKey, input.remoteId, conn.id));
      // Filed through a sink standing in for its tracker: deleted there.
      const filed = filedRow ? await companionEntry(filedRow) : null;
      if (filedRow && filed) {
        await deleteViaCompanion(filed, filedRow);
        return { ok: true, seconds: local[0]?.seconds ?? null, issueKey: input.issueKey, connectionId: conn.id };
      }
      const through = await contractTime(ctx.user.id, conn, input.issueKey);
      if (!through) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.worklogs.noTimeHere") });
      const [row] = await db.select().from(worklogs).where(worklogWhere(ctx.user.id, input.issueKey, input.remoteId, conn.id));
      if (row) {
        await deleteThrough(through, row);
        return { ok: true, seconds: local[0]?.seconds ?? null, issueKey: input.issueKey, connectionId: conn.id };
      }
      // Not read back here yet: the lock still follows its own week, read from the tracker; gone there too, nothing to do.
      // The tracker unreachable: the delete is queued, the replay sends it later.
      try {
        const there = through.b.worklogs?.get
          ? await through.b.worklogs.get(timeMeta(), through.ref, input.remoteId)
          : (await through.b.worklogs?.list(timeMeta(), through.ref))?.find((w) => w.remoteId === input.remoteId);
        if (!there) return { ok: true, seconds: local[0]?.seconds ?? null, issueKey: input.issueKey, connectionId: conn.id };
        if (there.span.kind === "session") await assertWeekOpen(ctx.user.id, new Date(there.span.start));
        await through.b.worklogs!.delete!(timeMeta(), through.ref, input.remoteId, {});
      } catch (e) {
        if (!(e instanceof ProviderError && e.transient)) throw e;
        await db.insert(outbox).values({ userId: ctx.user.id, connectionId: conn.id, kind: "delete", issueKey: input.issueKey, remoteId: input.remoteId });
      }
      return { ok: true, seconds: local[0]?.seconds ?? null, issueKey: input.issueKey, connectionId: conn.id };
    }),
});
