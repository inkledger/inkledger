import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { issues, plannedEntries, worklogs, type Connection, type PlannedEntry } from "@db/schema";
import { PLANNED_KINDS, plannedSeconds, type PlannedKind } from "@contracts/planned";
import { issueKeyInput, LIST_MAX_ROWS } from "../lib/inputs";
import { issueConnection } from "../providers/connections";
import { trackerAdapter } from "../providers/registry";
import type { TrackerCapabilities, TrackerType } from "@contracts/providers";
import { withWriteLease } from "../queries/writeLease";
import { assertWeeksOpen } from "./weeks";
import { worklogsRouter } from "./worklogs";
import { t } from "@contracts/i18n";

const instant = z.iso.datetime({ offset: true });
const fields = {
  kind: z.enum(PLANNED_KINDS),
  startsAt: instant,
  endsAt: instant,
  note: z.string().max(10_000).nullable().optional(),
  connectionId: z.number().int().positive().nullable().optional(),
  issueKey: issueKeyInput.nullable().optional(),
};

const createInput = z.object(fields);
const updateInput = z.object({ id: z.uuid(), ...fields }).partial().required({ id: true });
const idInput = z.object({ id: z.uuid() });
const listInput = z
  .object({ from: instant.optional(), to: instant.optional() })
  .refine((range) => !range.from || !range.to || new Date(range.from) < new Date(range.to), { message: "Invalid interval" })
  .optional();

type PlannedFields = {
  kind: PlannedKind;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
  connectionId: number | null;
  issueKey: string | null;
};

function bad(message: string): never {
  throw new TRPCError({ code: "BAD_REQUEST", message });
}

async function ownPlanned(userId: number, id: string): Promise<PlannedEntry> {
  const [row] = await getDb()
    .select()
    .from(plannedEntries)
    .where(and(eq(plannedEntries.id, id), eq(plannedEntries.userId, userId)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.planned.notFound") });
  return row;
}

async function normalizeFields(userId: number, value: PlannedFields, explicitVacationRefs = false): Promise<PlannedFields> {
  if (value.endsAt <= value.startsAt) bad(t("server.planned.invalidInterval"));
  if (value.kind === "vacation") {
    if (explicitVacationRefs) bad(t("server.planned.vacationNoIssue"));
    return { ...value, connectionId: null, issueKey: null };
  }
  if (value.kind === "work" && !value.issueKey) bad(t("server.planned.workIssueRequired"));
  if (!value.issueKey) {
    if (value.connectionId !== null) bad(t("server.planned.connectionNeedsIssue"));
    return value;
  }
  const conn = await issueConnection(userId, value.issueKey, value.connectionId ?? undefined);
  const [issue] = await getDb()
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.userId, userId), eq(issues.connectionId, conn.id), eq(issues.key, value.issueKey)))
    .limit(1);
  if (!issue) throw new TRPCError({ code: "NOT_FOUND", message: t("server.planned.issueNotFound") });
  return { ...value, connectionId: conn.id };
}

function entryLimits(capabilities: TrackerCapabilities | undefined) {
  return capabilities?.time.mode === "entries" ? capabilities.time.entries.limits : undefined;
}

function refusesFuture(conn: Connection): boolean {
  if (entryLimits(trackerAdapter(conn.type as TrackerType)?.capabilities)?.noFuture) return true;
  if (!conn.probe) return false;
  try {
    const probe = JSON.parse(conn.probe) as { capabilities?: TrackerCapabilities };
    return entryLimits(probe.capabilities)?.noFuture === true;
  } catch {
    return false;
  }
}

export const plannedRouter = createRouter({
  list: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const conditions = [eq(plannedEntries.userId, ctx.user.id)];
    if (input?.from) conditions.push(gt(plannedEntries.endsAt, new Date(input.from)));
    if (input?.to) conditions.push(lt(plannedEntries.startsAt, new Date(input.to)));
    return getDb()
      .select()
      .from(plannedEntries)
      .where(and(...conditions))
      .orderBy(asc(plannedEntries.startsAt), asc(plannedEntries.id))
      .limit(LIST_MAX_ROWS);
  }),

  create: protectedProcedure.input(createInput).mutation(async ({ ctx, input }) =>
    withWriteLease(ctx.user.id, async () => {
      const value = await normalizeFields(ctx.user.id, {
        kind: input.kind,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        note: input.note ?? null,
        connectionId: input.connectionId ?? null,
        issueKey: input.issueKey ?? null,
      }, input.kind === "vacation" && (input.connectionId != null || input.issueKey != null));
      await assertWeeksOpen(ctx.user.id, value.startsAt, value.endsAt);
      const [saved] = await getDb().insert(plannedEntries).values({ ...value, userId: ctx.user.id }).returning();
      return saved;
    }),
  ),

  update: protectedProcedure.input(updateInput).mutation(async ({ ctx, input }) =>
    withWriteLease(ctx.user.id, async () => {
      const current = await ownPlanned(ctx.user.id, input.id);
      const kind = input.kind ?? current.kind;
      const value = await normalizeFields(ctx.user.id, {
        kind,
        startsAt: input.startsAt ? new Date(input.startsAt) : current.startsAt,
        endsAt: input.endsAt ? new Date(input.endsAt) : current.endsAt,
        note: input.note === undefined ? current.note : input.note,
        connectionId: input.connectionId === undefined ? current.connectionId : input.connectionId,
        issueKey: input.issueKey === undefined ? current.issueKey : input.issueKey,
      }, kind === "vacation" && (input.connectionId != null || input.issueKey != null));
      await assertWeeksOpen(ctx.user.id, current.startsAt, current.endsAt);
      await assertWeeksOpen(ctx.user.id, value.startsAt, value.endsAt);
      const [saved] = await getDb()
        .update(plannedEntries)
        .set({ ...value, updatedAt: new Date() })
        .where(and(eq(plannedEntries.id, current.id), eq(plannedEntries.userId, ctx.user.id)))
        .returning();
      return saved;
    }),
  ),

  remove: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) =>
    withWriteLease(ctx.user.id, async () => {
      const current = await ownPlanned(ctx.user.id, input.id);
      await assertWeeksOpen(ctx.user.id, current.startsAt, current.endsAt);
      await getDb().delete(plannedEntries).where(and(eq(plannedEntries.id, current.id), eq(plannedEntries.userId, ctx.user.id)));
      return { ok: true };
    }),
  ),

  convert: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) =>
    withWriteLease(ctx.user.id, async () => {
      const planned = await ownPlanned(ctx.user.id, input.id);
      if (planned.convertedWorklogId !== null) {
        const [worklog] = await getDb()
          .select()
          .from(worklogs)
          .where(and(eq(worklogs.id, planned.convertedWorklogId), eq(worklogs.userId, ctx.user.id)))
          .limit(1);
        if (!worklog) throw new TRPCError({ code: "NOT_FOUND", message: t("server.worklogs.notFound") });
        return { planned, worklog };
      }
      if (planned.kind === "vacation") bad(t("server.planned.notConvertible"));
      if (!planned.issueKey || planned.connectionId === null) bad(t("server.planned.travelIssueRequired"));
      await assertWeeksOpen(ctx.user.id, planned.startsAt, planned.endsAt);
      const conn = await issueConnection(ctx.user.id, planned.issueKey, planned.connectionId);
      if (planned.startsAt.getTime() > Date.now() && refusesFuture(conn)) bad(t("server.planned.noFuture"));
      const worklog = await worklogsRouter.createCaller(ctx).create({
        issueKey: planned.issueKey,
        connectionId: planned.connectionId,
        seconds: plannedSeconds(planned),
        started: planned.startsAt.toISOString(),
        comment: planned.note ?? "",
        fromTimer: false,
      });
      const [converted] = await getDb()
        .update(plannedEntries)
        .set({ convertedWorklogId: worklog.id, updatedAt: new Date() })
        .where(and(eq(plannedEntries.id, planned.id), eq(plannedEntries.userId, ctx.user.id), isNull(plannedEntries.convertedWorklogId)))
        .returning();
      if (!converted) throw new TRPCError({ code: "CONFLICT", message: t("server.planned.notFound") });
      return { planned: converted, worklog };
    }),
  ),
});
