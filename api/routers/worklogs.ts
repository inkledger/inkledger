import { answer } from "../decisions/store";
import { whoOf } from "./timers";
import { companionOf, dropHeldSinkDeletes, holdSinkDeletes, markForSinks, sinksSoon } from "../sync/extraSinks";
import { companionEntry, createViaCompanion, deleteViaCompanion, updateViaCompanion } from "../sync/companion";
import { ProviderError } from "../providers/core/errors";
import { worklogScope } from "../queries/worklogScope";
import type { RemoteSnapshot } from "../sync/worklogs";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, like, lt, not, notInArray, or, type SQL } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { randomUUID } from "node:crypto";
import { outbox, timerOps, worklogs, worklogSinks, worklogTrash, type Connection, type User, type Worklog } from "@db/schema";
import { record, type AuditRequest } from "../lib/audit";
import superjson from "superjson";
import type { TrackerType } from "@contracts/providers";
import {
  fetchWorklogs,
  isAuthor,
  textFromAdf,
  type JiraWorklog,
} from "../jira/client";
import {
  MAX_WORKLOG_SECONDS,
  parseDurationToSeconds,
} from "@contracts/time";
import { assertWeekOpen } from "./weeks";
import { claimTimerSeconds } from "./timers";
import { withOutboxLock } from "./outbox";
import { assertNoOverlap } from "../queries/overlap";
import { occupiedId } from "@contracts/placement";
import { TRASH_DAYS, withDeleteReason } from "../queries/trash";
import { buriedOn, syncWorklogs } from "../worklogSync";
import { issueKeyInput, LIST_MAX_ROWS } from "../lib/inputs";
import { t } from "@contracts/i18n";
import { isPendingId, PENDING_PREFIX } from "@contracts/types";
import { contextFor, issueConnection } from "../providers/connections";
import { trackerAdapter } from "../providers/registry";
import { buryLostCreate, CLAIM_TTL_MS, contractTime, createThrough, creationInFlight, deleteThrough, updateThrough } from "../sync/timeWrites";
import { withWriteLease } from "../queries/writeLease";
import { deleteThere } from "../sync/worklogs";
import { callMeta } from "../lib/callMeta";

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


/** Id of a worklog kept only in inkledger: its tracker keeps no time (GitHub). */
const LOCAL_PREFIX = "local-";

function isLocalId(remoteId: string): boolean {
  return remoteId.startsWith(LOCAL_PREFIX);
}

/** The tracker keeps no time of its own: inkledger is where its worklogs live. */
function keepsTimeLocally(conn: Pick<Connection, "type">): boolean {
  return trackerAdapter(conn.type as TrackerType)?.capabilities.time.mode === "local";
}

/**
 * A pending worklog's queued create, as an edit or a delete may take it: still
 * queued as a create (once replayed it has a real id, and an edit by the old one
 * would do nothing; a replay that adopted it may have left it a queued edit, never
 * the old id's to drop) and claimed by no replay, of this process or another on the same
 * database (a claim past its lease is a dead process's).
 */
function stillQueued(userId: number, outboxId: number) {
  return and(eq(outbox.id, outboxId), eq(outbox.userId, userId), eq(outbox.kind, "create"), or(isNull(outbox.claimedAt), lt(outbox.claimedAt, Date.now() - CLAIM_TTL_MS)));
}

function pendingOutboxId(remoteId: string): number {
  return parseInt(remoteId.slice(PENDING_PREFIX.length), 10);
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

export async function upsertLocal(row: ReturnType<typeof rowFromJira>): Promise<void> {
  await getDb()
    .insert(worklogs)
    .values(row)
    .onConflictDoUpdate({
      target: [worklogs.userId, worklogs.connectionId, worklogs.issueKey, worklogs.remoteId],
      set: row,
    });
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


/** What timer_ops holds for a log still running, or one that wrote part of its worklogs and failed (never JSON). */
const OP_PENDING = "!pending";
const OP_PARTIAL = "!partial";

/**
 * A log runs once per `opId` (kept in timer_ops as "wl:<opId>", under the user's write
 * lease): a retry gets the first answer back. Reserved before anything is written, so a
 * retry while the first still runs (or died halfway) is refused, never run twice. A failure
 * before any worklog was written frees the opId; after one was, it stays refused.
 */
async function onceLogged<T>(userId: number, opId: string | undefined, run: (logged: () => void) => Promise<T>): Promise<T> {
  if (!opId) return run(() => undefined);
  const db = getDb();
  const key = and(eq(timerOps.userId, userId), eq(timerOps.opId, `wl:${opId}`));
  const [prior] = await db.select({ result: timerOps.result }).from(timerOps).where(key);
  if (prior) {
    if (prior.result === OP_PENDING || prior.result === OP_PARTIAL) throw new TRPCError({ code: "CONFLICT", message: t("server.worklogs.busy") });
    return superjson.parse<T>(prior.result);
  }
  await db.insert(timerOps).values({ userId, opId: `wl:${opId}`, result: OP_PENDING });
  let wrote = false;
  try {
    const result = await run(() => {
      wrote = true;
    });
    await db.update(timerOps).set({ result: superjson.stringify(result) }).where(key);
    return result;
  } catch (e) {
    await (wrote ? db.update(timerOps).set({ result: OP_PARTIAL }).where(key) : db.delete(timerOps).where(key)).catch((err: unknown) => console.error(err));
    throw e;
  }
}

type Logged = Pick<Worklog, "id" | "userId" | "issueKey" | "connectionId" | "timeSpentSeconds" | "started">;
type LoggedFields = Pick<Worklog, "issueKey" | "connectionId" | "timeSpentSeconds" | "started">;

/** A worklog written by its user, in the audit log: when, how long, where; never its comment. */
function auditWorklog(ctx: AuditRequest, action: "worklog.create" | "worklog.update" | "worklog.restore", w: Logged, before: LoggedFields | null, after: LoggedFields) {
  const fields = (f: LoggedFields) => ({ issueKey: f.issueKey, connectionId: f.connectionId, seconds: f.timeSpentSeconds, started: f.started });
  return record(ctx, action, { target: { type: "worklog", id: w.id, ownerUserId: w.userId }, before: before ? fields(before) : null, after: fields(after) });
}

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
      return withWriteLease(ctx.user.id, async () => {
        if (input.keep === "theirs") {
          await db.update(worklogs).set({ timeSpentSeconds: remote.seconds, started: new Date(remote.started), comment: remote.comment, syncedAt: new Date() }).where(eq(worklogs.id, row.id));
          await db.delete(outbox).where(and(eq(outbox.worklogId, row.id), eq(outbox.connectionId, sink.sinkConnectionId)));
          await db.update(worklogSinks).set({ state: "synced", remoteSnapshot: null, lastError: null }).where(eq(worklogSinks.id, sink.id));
        } else {
          const conn = await issueConnection(ctx.user.id, row.issueKey, sink.sinkConnectionId);
          const through = await contractTime(ctx.user.id, conn, row.issueKey);
          if (!through) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.worklogs.noConflict") });
          await db.update(worklogSinks).set({ state: "pending", remoteSnapshot: null }).where(eq(worklogSinks.id, sink.id));
          try {
            await updateThrough(through, row, { timeSpentSeconds: row.timeSpentSeconds, started: row.started, comment: row.comment });
          } catch (e) {
            // Refused there: the conflict stays as it was, theirs beside it, to settle again
            // (unless something else already moved the row on).
            await db
              .update(worklogSinks)
              .set({ state: "conflict", remoteSnapshot: sink.remoteSnapshot })
              .where(and(eq(worklogSinks.id, sink.id), eq(worklogSinks.state, "pending"), isNull(worklogSinks.remoteSnapshot)));
            throw e;
          }
        }
        const [after] = await db.select().from(worklogs).where(eq(worklogs.id, row.id));
        await record(ctx, "worklog.resolveConflict", { target: { type: "worklog", id: row.id, ownerUserId: row.userId }, after: { issueKey: row.issueKey, keep: input.keep } });
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
      const remote = await through.b.worklogs.list(callMeta("team"), through.ref);
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
      // Jira's client reaches Jira only: on another tracker it reads the wrong API.
      if (conn.type !== "jira") return { synced: 0 };
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
      const mine = remote.filter((w) => isAuthor(w.author, user.accountId));
      const buried = await buriedOn(ctx.user.id, conn);
      for (const w of mine) {
        if (queued.has(w.id) || buried(input.issueKey, w)) continue;
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
            // One still being created (its answer on the way) stays too.
            not(creationInFlight()),
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
          /** With fromTimer, a log shorter than the stopped timer: keep the rest paused to log later (else it is dropped). */
          keepRest: z.boolean().default(false),
          /** The question this log answers (contracts/decisions): the first page to answer it wins. */
          decision: z.object({ id: z.uuid(), revision: z.number().int().nonnegative() }).optional(),
          /** One per log the user asked for: a retry with it (a lost answer, a second click) gets the first answer back. */
          opId: z.string().min(8).max(100).optional(),
          /** With fromTimer: the timer's epoch the page saw. Changed since (another device logged it), the log is refused. */
          timerEpoch: z.number().int().nonnegative().optional(),
          /**
           * The same time split around the day's breaks (contracts/placement.ts):
           * one worklog per part, in order, adding up to `seconds`. The timer's
           * time is taken once for all of them.
           */
          parts: z
            .array(z.object({ started: z.iso.datetime({ offset: true }), seconds: z.number().int().min(60).max(MAX_WORKLOG_SECONDS) }))
            .min(2)
            .max(5)
            .optional(),
          /**
           * A timer that ran beside others (contracts/timerSplit.ts): the time it
           * counted up to `until` is all taken, its shares of the time together
           * (by the others it ran with, in basis points) recorded for their logs.
           */
          split: z
            .object({
              until: z.iso.datetime({ offset: true }),
              shares: z.array(z.object({ with: z.array(z.string().min(1).max(120)).min(1).max(8), bp: z.number().int().min(0).max(10000) })).max(20),
            })
            .optional(),
        })
        .refine(hasDuration, "seconds or timeSpent"),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.split && !input.fromTimer) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.worklogs.splitNotTimer") });
      const { seconds, started } = parseLogInput(input);
      const parts = input.parts
        ? input.parts.map((p) => ({ started: new Date(p.started), seconds: p.seconds }))
        : [{ started, seconds }];
      const inOrder = parts.every((p, i) => i === 0 || p.started.getTime() >= parts[i - 1].started.getTime() + parts[i - 1].seconds * 1000);
      if (parts.reduce((a, p) => a + p.seconds, 0) !== seconds || !inOrder) {
        throw new TRPCError({ code: "BAD_REQUEST", message: t("server.worklogs.invalidParts") });
      }
      const write = () => withWriteLease(ctx.user.id, () => onceLogged(ctx.user.id, input.opId, async (logged) => {
        // Every part checked before anything is written or taken from the timer.
        for (const p of parts) {
          await assertWeekOpen(ctx.user.id, p.started);
          await assertNoOverlap(ctx.user.id, { start: p.started, seconds: p.seconds });
        }
        // A timer's time is logged once: it is taken under the database lock
        // before the worklog is written, so two devices logging it at once
        // can't both succeed (gone means another flow logged it). A stopped
        // timer is cleared; one restarted meanwhile keeps running minus this
        // time. A shorter log drops the rest of a stopped one unless asked to
        // keep it. If the worklog then fails, the time goes back to the timer.
        const split = input.split ? { until: new Date(input.split.until), shares: input.split.shares } : undefined;
        const claim = input.fromTimer
          ? await claimTimerSeconds(ctx.user.id, input.issueKey, seconds, input.connectionId, new Date(), { split, keepRest: input.keepRest, epoch: input.timerEpoch })
          : null;
        if (input.fromTimer && !claim) {
          throw new TRPCError({ code: "CONFLICT", message: t("server.worklogs.timerLogged", { key: input.issueKey }) });
        }
        // A part that fails gives back the time not logged yet; the parts before it stay logged.
        const saved: Awaited<ReturnType<typeof createWorklog>>[] = [];
        let left = seconds;
        for (const p of parts) {
          const one = await createWorklog(ctx.user, input, p.seconds, p.started).catch(async (e: unknown) => {
            await claim?.undo(left);
            throw e;
          });
          left -= p.seconds;
          saved.push(one);
          logged();
          await auditWorklog(ctx, "worklog.create", one, null, one);
          // Its time goes to the user's time sinks too, in the background.
          await markForSinks(ctx.user.id, one.id);
        }
        sinksSoon(ctx.user.id);
        return saved[0];
      }));
      if (!input.decision) return write();
      const w = whoOf(ctx);
      return answer(ctx.user.id, input.decision, { client: w.client, label: w.label }, "logged", write, (r) => ({ worklogId: r.id }));
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
      const saved = await withWriteLease(ctx.user.id, async () => {
        // Again under the lock: a week closed meanwhile (another device, another process).
        await assertWeekOpen(ctx.user.id, started);
        if (current) await assertWeekOpen(ctx.user.id, current.started);
        if (moved) {
          await assertNoOverlap(ctx.user.id, { start: started, seconds }, occupiedId({ connectionId: conn.id, remoteId: input.remoteId }));
        }
        const fields = { timeSpentSeconds: seconds, started, comment: input.comment };
        // Kept only in inkledger: nothing to tell a tracker.
        if (isLocalId(input.remoteId)) {
          const saved = await updateLocalWorklog(ctx.user.id, input.issueKey, input.remoteId, fields, conn.id);
          // Named by issue and id (an older app): gone meanwhile, nothing was changed.
          if (!saved) throw new TRPCError({ code: "NOT_FOUND", message: t("server.worklogs.notFound") });
          return saved;
        }
        // Pending worklog: only the local copy changes; its queued create keeps the values
        // sent (they may have landed: the replay looks for those, then sends these).
        if (isPendingId(input.remoteId)) {
          const oid = pendingOutboxId(input.remoteId);
          return await withOutboxLock(ctx.user.id, () =>
            // The queued create and the copy here change together, only while no replay
            // (another process on this database included) is sending it.
            getDb().transaction(async (tx) => {
              const [taken] = await tx.select({ id: outbox.id }).from(outbox).where(stillQueued(ctx.user.id, oid)).for("update");
              if (!taken) throw new TRPCError({ code: "CONFLICT", message: t("server.worklogs.justSynced") });
              const [saved] = await tx.update(worklogs).set(fields).where(worklogWhere(ctx.user.id, input.issueKey, input.remoteId, conn.id)).returning();
              return saved;
            }),
          );
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
      await auditWorklog(ctx, "worklog.update", saved, current ? { started: current.started, timeSpentSeconds: current.seconds, issueKey: saved.issueKey, connectionId: saved.connectionId } : null, saved);
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
    return withWriteLease(ctx.user.id, async () => {
      await assertWeekOpen(ctx.user.id, item.started);
      // Taken from the trash first, in one statement: a second restore of it (a double
      // click, another device, another process) finds it gone and logs nothing.
      const [taken] = await db
        .delete(worklogTrash)
        .where(and(eq(worklogTrash.id, item.id), eq(worklogTrash.userId, ctx.user.id)))
        .returning();
      if (!taken) throw new TRPCError({ code: "NOT_FOUND", message: t("server.worklogs.notFound") });
      let saved;
      try {
        await assertNoOverlap(ctx.user.id, { start: taken.started, seconds: taken.timeSpentSeconds });
        saved = await createWorklog(ctx.user, { issueKey: taken.issueKey, comment: taken.comment, connectionId: taken.connectionId ?? undefined }, taken.timeSpentSeconds, taken.started);
      } catch (e) {
        // Not restored: back in the trash, as it was.
        await db.insert(worklogTrash).values(taken);
        throw e;
      }
      // Its time goes to the user's time sinks again, as a new worklog's does.
      await markForSinks(ctx.user.id, saved.id);
      sinksSoon(ctx.user.id);
      await auditWorklog(ctx, "worklog.restore", saved, null, saved);
      return saved;
    });
  }),

  delete: protectedProcedure
    .input(z.object(worklogRefFields).refine(hasRef, "id, or issueKey and remoteId"))
    .mutation(async ({ ctx, input: given }) => {
      const input = await worklogRef(ctx.user.id, given);
      const conn = await issueConnection(ctx.user.id, input.issueKey, input.connectionId);
      const db = getDb();
      return withWriteLease(ctx.user.id, () => deleteLocked());

      async function deleteLocked() {
        const where = worklogWhere(ctx.user.id, input.issueKey, input.remoteId, conn.id);
        // Read once: nothing here writes the row before it goes.
        const [whole] = await db.select().from(worklogs).where(where);
        // The lock is driven by the worklog's own week, not the current one.
        if (whole) await assertWeekOpen(ctx.user.id, whole.started);
        await assertUnlocked(where);
        // Its entries on the time sinks go too: held now (its rows go with it), due once it is gone.
        if (whole) await holdSinkDeletes(whole);
        try {
          const done = await deleteNow();
          if (whole) sinksSoon(ctx.user.id);
          await record(ctx, "worklog.delete", { target: { type: "worklog", id: whole?.id ?? input.remoteId, ownerUserId: ctx.user.id }, before: { issueKey: input.issueKey, connectionId: conn.id, seconds: whole?.timeSpentSeconds ?? null } });
          return done;
        } catch (e) {
          // Still here (its tracker refused): its sinks keep their entries.
          if (whole) await dropHeldSinkDeletes(whole.id);
          throw e;
        }

        function deleted() {
          return { ok: true, seconds: whole?.timeSpentSeconds ?? null, issueKey: input.issueKey, connectionId: conn.id };
        }

        async function deleteNow() {
          // Kept only in inkledger: it goes to the trash, no tracker to tell.
          if (isLocalId(input.remoteId)) {
            await deleteLocalWorklog(ctx.user.id, input.issueKey, input.remoteId, conn.id);
            return deleted();
          }
          // Pending worklog: its queued create goes (a delete looks for it there, should it have landed).
          if (isPendingId(input.remoteId)) {
            const oid = pendingOutboxId(input.remoteId);
            return await withOutboxLock(ctx.user.id, async () => {
              // Only while no replay (another process on this database included) is sending it.
              await withDeleteReason("user", async (tx) => {
                const [taken] = await tx.delete(outbox).where(stillQueued(ctx.user.id, oid)).returning();
                if (!taken) throw new TRPCError({ code: "CONFLICT", message: t("server.worklogs.justSynced") });
                await tx.delete(worklogs).where(where);
                // Its create may have landed, the answer lost: looked for there and deleted.
                await buryLostCreate(taken, tx);
              });
              return deleted();
            });
          }
          // Filed through a sink standing in for its tracker: deleted there.
          const filed = whole ? await companionEntry(whole) : null;
          if (whole && filed) {
            await deleteViaCompanion(filed, whole);
            return deleted();
          }
          const through = await contractTime(ctx.user.id, conn, input.issueKey);
          if (!through) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.worklogs.noTimeHere") });
          if (whole) {
            await deleteThrough(through, whole);
            return deleted();
          }
          // Not read back here yet: the lock still follows its own week, read from the tracker; gone there too, nothing to do.
          // The tracker unreachable: the delete is queued, the replay sends it later.
          let checked = false;
          try {
            const there = through.b.worklogs?.get
              ? await through.b.worklogs.get(callMeta("time"), through.ref, input.remoteId)
              : (await through.b.worklogs?.list(callMeta("time"), through.ref))?.find((w) => w.remoteId === input.remoteId);
            if (!there) return deleted();
            // Someone else's entry (listed by team): never deleted from here, whatever the tracker allows.
            if (there.authorRemoteId && there.authorRemoteId !== conn.remoteAccountId) {
              throw new TRPCError({ code: "FORBIDDEN", message: t("server.worklogs.notYours") });
            }
            checked = true;
            if (there.span.kind === "session") await assertWeekOpen(ctx.user.id, new Date(there.span.start));
            await deleteThere(through.b, callMeta("time"), through.ref, input.remoteId);
          } catch (e) {
            // Gone there meanwhile (read, then deleted elsewhere): done, as for an entry read back.
            if (e instanceof ProviderError && e.kind === "notFound") return deleted();
            // Its author not read yet: never queued unchecked (it may be someone else's).
            if (!(e instanceof ProviderError && e.transient) || !checked) throw e;
            await db.insert(outbox).values({ userId: ctx.user.id, connectionId: conn.id, kind: "delete", issueKey: input.issueKey, remoteId: input.remoteId });
          }
          return deleted();
        }
      }
    }),
});
