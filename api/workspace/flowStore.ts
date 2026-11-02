import { t } from "@contracts/i18n";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { workspaceDrafts, workspaceFlowAggregates, workspaceFlowEvents, workspaceFlowFeedback, workspaceFlowImports, workspaceFlowSettings, workspacePlannerFeedback } from "@db/schema";
import { getDb, q } from "../queries/connection";
import type { EvidenceSet, FlowEvent, FlowMapDocument } from "@contracts/workspace/flowMap";
import type { Scope } from "@contracts/workspace/model";
import { flowEvidenceSchema, flowEventSchema, flowMapDocumentSchema } from "./flowValidation";
import { xactLock } from "../queries/locks";

function scopeWhere(scope: Scope) {
  return (table: { surfaceId: AnyPgColumn; deviceClass: AnyPgColumn }) =>
    and(eq(table.surfaceId, scope.surfaceId), eq(table.deviceClass, scope.deviceClass));
}

export async function getFlowSettings(userId: number) {
  const rows = await getDb().select().from(workspaceFlowSettings).where(eq(workspaceFlowSettings.userId, userId)).limit(1);
  return rows[0] ?? { enabled: false, rawRetentionDays: 30, aggregateRetentionDays: 365 };
}

export async function setFlowConsent(userId: number, enabled: boolean) {
  await getDb().transaction(async tx => {
    await xactLock(tx, `flow:${userId}`);
    await tx.insert(workspaceFlowSettings).values({ userId, enabled, updatedAt: Date.now() }).onConflictDoUpdate({
      target: workspaceFlowSettings.userId,
      set: { enabled, updatedAt: Date.now() },
    });
  });
  return getFlowSettings(userId);
}

/** Raw events kept per user at most: the newest ones, whatever the retention window allows. */
const FLOW_MAX_EVENTS_PER_USER = 100_000;
const lastPruned = new Map<number, number>();

export async function pruneFlowData(userId: number, now = Date.now(), maxEvents = FLOW_MAX_EVENTS_PER_USER): Promise<void> {
  // At most once a minute per user: every ingest batch asks, the deletes need not run for each.
  if ((lastPruned.get(userId) ?? -Infinity) > now - 60_000) return;
  lastPruned.set(userId, now);
  if (lastPruned.size > 10_000) lastPruned.clear();
  const settings = await getFlowSettings(userId);
  await getDb().execute(sql`DELETE FROM workspace_flow_events WHERE user_id = ${userId} AND id IN (SELECT id FROM workspace_flow_events WHERE user_id = ${userId} ORDER BY occurred_at DESC, id DESC OFFSET ${maxEvents})`);
  await Promise.all([
    getDb().delete(workspaceFlowEvents).where(and(eq(workspaceFlowEvents.userId, userId), lt(workspaceFlowEvents.occurredAt, now - settings.rawRetentionDays * 86_400_000))),
    getDb().delete(workspaceFlowAggregates).where(and(eq(workspaceFlowAggregates.userId, userId), lt(workspaceFlowAggregates.createdAt, now - settings.aggregateRetentionDays * 86_400_000))),
    getDb().delete(workspaceFlowImports).where(and(eq(workspaceFlowImports.userId, userId), lt(workspaceFlowImports.createdAt, now - settings.aggregateRetentionDays * 86_400_000))),
  ]);
}

/**
 * The boot purge: every user's retention, FlowMap on or off (turning it off stops the collection,
 * it does not keep what was collected forever). Per-user windows, 30 and 365 days by default.
 */
export async function purgeFlowRetention(now = Date.now()): Promise<void> {
  const window = (column: "raw_retention_days" | "aggregate_retention_days", fallback: number) =>
    sql`${now}::bigint - COALESCE((SELECT ${sql.raw(column)} FROM workspace_flow_settings s WHERE s.user_id = t.user_id), ${fallback})::bigint * 86400000`;
  await getDb().execute(sql`DELETE FROM workspace_flow_events t WHERE t.occurred_at < ${window("raw_retention_days", 30)}`);
  await getDb().execute(sql`DELETE FROM workspace_flow_aggregates t WHERE t.created_at < ${window("aggregate_retention_days", 365)}`);
  await getDb().execute(sql`DELETE FROM workspace_flow_imports t WHERE t.created_at < ${window("aggregate_retention_days", 365)}`);
}

export async function saveFlowEvents(userId: number, events: readonly FlowEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  return getDb().transaction(async tx => {
    await xactLock(tx, `flow:${userId}`);
    const settings = await tx.select({ enabled: workspaceFlowSettings.enabled }).from(workspaceFlowSettings).where(eq(workspaceFlowSettings.userId, userId)).limit(1);
    if (!settings[0]?.enabled) return 0;
    const inserted = await tx.insert(workspaceFlowEvents).values(events.map(event => ({
      userId,
      id: event.id,
      surfaceId: event.scope.surfaceId,
      deviceClass: event.scope.deviceClass,
      effectiveRevision: event.descriptor.effectiveRevision,
      occurredAt: event.occurredAt,
      payload: JSON.stringify(flowEventSchema.parse(event)),
      receivedAt: Date.now(),
    }))).onConflictDoNothing().returning({ id: workspaceFlowEvents.id });
    return inserted.length;
  });
}

/** One presentation's events, all of them or (`since`) only the recent ones. */
export async function loadFlowEvents(userId: number, scope: Scope, effectiveRevision: string, since?: number): Promise<FlowEvent[]> {
  const rows = await getDb().select().from(workspaceFlowEvents).where(and(
    eq(workspaceFlowEvents.userId, userId),
    scopeWhere(scope)(workspaceFlowEvents),
    eq(workspaceFlowEvents.effectiveRevision, effectiveRevision),
    since === undefined ? undefined : gte(workspaceFlowEvents.occurredAt, since),
  )).orderBy(workspaceFlowEvents.occurredAt, workspaceFlowEvents.id);
  // A row this version cannot read (written by another one, or damaged) is left out: one event never takes every map down.
  return rows.flatMap(row => {
    try {
      const parsed = flowEventSchema.safeParse(JSON.parse(row.payload));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

export async function saveEvidence(userId: number, evidence: EvidenceSet): Promise<void> {
  const validated = flowEvidenceSchema.parse(evidence);
  await getDb().transaction(async tx => {
    await xactLock(tx, `flow:${userId}`);
    const settings = await tx.select({ enabled: workspaceFlowSettings.enabled }).from(workspaceFlowSettings).where(eq(workspaceFlowSettings.userId, userId)).limit(1);
    if (!settings[0]?.enabled) return;
    await tx.insert(workspaceFlowAggregates).values({
      userId,
      id: validated.evidenceId,
      surfaceId: validated.scope.surfaceId,
      deviceClass: validated.scope.deviceClass,
      effectiveRevision: validated.descriptor.effectiveRevision,
      origin: validated.origin,
      payload: JSON.stringify(validated),
    }).onConflictDoUpdate({ target: [workspaceFlowAggregates.userId, workspaceFlowAggregates.id], set: { payload: JSON.stringify(validated), origin: validated.origin } });
  });
}

function withExpectationFeedback(evidence: EvidenceSet, feedback: Record<string, "unconfirmed" | "confirmed" | "rejected">): EvidenceSet {
  return { ...evidence, expectations: evidence.expectations.map(gap => ({ ...gap, state: feedback[gap.id] ?? gap.state })) };
}

export async function listEvidence(userId: number, scope: Scope): Promise<EvidenceSet[]> {
  const rows = await getDb().select().from(workspaceFlowAggregates).where(and(eq(workspaceFlowAggregates.userId, userId), scopeWhere(scope)(workspaceFlowAggregates))).orderBy(desc(workspaceFlowAggregates.createdAt)).limit(50);
  const feedback = await feedbackById(userId);
  return rows.map(row => withExpectationFeedback(flowEvidenceSchema.parse(JSON.parse(row.payload)), feedback));
}

export async function evidenceById(userId: number, id: string, scope: Scope): Promise<EvidenceSet | null> {
  const rows = await getDb().select().from(workspaceFlowAggregates).where(and(eq(workspaceFlowAggregates.userId, userId), eq(workspaceFlowAggregates.id, id), scopeWhere(scope)(workspaceFlowAggregates))).limit(1);
  if (!rows[0]) return null;
  return withExpectationFeedback(flowEvidenceSchema.parse(JSON.parse(rows[0].payload)), await feedbackById(userId));
}

export async function saveFlowImport(userId: number, document: FlowMapDocument, id: string): Promise<void> {
  const validated = flowMapDocumentSchema.parse(document);
  await getDb().transaction(async tx => {
    await xactLock(tx, `flow:${userId}`);
    // As every other FlowMap write: only with consent, checked under the lock a Delete takes too (D-37).
    const settings = await tx.select({ enabled: workspaceFlowSettings.enabled }).from(workspaceFlowSettings).where(eq(workspaceFlowSettings.userId, userId)).limit(1);
    if (!settings[0]?.enabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.workspace.flowOff") });
    await tx.insert(workspaceFlowImports).values({ userId, id, surfaceId: document.scope.surfaceId, deviceClass: document.scope.deviceClass, document: JSON.stringify(validated) });
  });
}

export async function listFlowImports(userId: number, scope: Scope) {
  const rows = await getDb().select().from(workspaceFlowImports).where(and(eq(workspaceFlowImports.userId, userId), scopeWhere(scope)(workspaceFlowImports))).orderBy(desc(workspaceFlowImports.createdAt)).limit(20);
  return rows.map(row => ({ importId: row.id, origin: "import" as const, document: flowMapDocumentSchema.parse(JSON.parse(row.document)) }));
}

export async function feedbackById(userId: number): Promise<Record<string, "unconfirmed" | "confirmed" | "rejected">> {
  const rows = await getDb().select().from(workspaceFlowFeedback).where(eq(workspaceFlowFeedback.userId, userId));
  return Object.fromEntries(rows.map(row => [row.id, row.status as "unconfirmed" | "confirmed" | "rejected"]));
}

/** False when collection is off: nothing is stored then, and the caller must not say it was. */
export async function setExpectationFeedback(userId: number, id: string, status: "unconfirmed" | "confirmed" | "rejected"): Promise<boolean> {
  return getDb().transaction(async tx => {
    await xactLock(tx, `flow:${userId}`);
    const settings = await tx.select({ enabled: workspaceFlowSettings.enabled }).from(workspaceFlowSettings).where(eq(workspaceFlowSettings.userId, userId)).limit(1);
    if (!settings[0]?.enabled) return false;
    await tx.insert(workspaceFlowFeedback).values({ userId, id, status, updatedAt: Date.now() }).onConflictDoUpdate({ target: [workspaceFlowFeedback.userId, workspaceFlowFeedback.id], set: { status, updatedAt: Date.now() } });
    return true;
  });
}

export async function deleteFlowData(userId: number): Promise<void> {
  await getDb().transaction(async tx => {
    await xactLock(tx, `flow:${userId}`);
    await tx.delete(workspaceFlowEvents).where(eq(workspaceFlowEvents.userId, userId));
    await tx.delete(workspaceFlowAggregates).where(eq(workspaceFlowAggregates.userId, userId));
    await tx.delete(workspaceFlowImports).where(eq(workspaceFlowImports.userId, userId));
    await tx.delete(workspaceFlowFeedback).where(eq(workspaceFlowFeedback.userId, userId));
    await tx.delete(workspacePlannerFeedback).where(eq(workspacePlannerFeedback.userId, userId));
    // Drafts keep their operations but no longer point at evidence that is gone, nor at what it suggested (§16.2).
    // Rewritten here in the same compact JSON the draft store writes, so its compare-and-swap still matches.
    const drafts = await tx.select({ id: workspaceDrafts.id, surfaceId: workspaceDrafts.surfaceId, deviceClass: workspaceDrafts.deviceClass, patches: workspaceDrafts.patches })
      .from(workspaceDrafts).where(and(eq(workspaceDrafts.userId, userId), sql`${workspaceDrafts.patches} LIKE '%evidenceId%'`));
    for (const draft of drafts) {
      const patches = (JSON.parse(draft.patches) as Record<string, unknown>[]).map(patch => ({ ...patch, evidence: [], suggestionSignature: undefined, expectedOutcome: undefined }));
      await tx.update(workspaceDrafts).set({ patches: JSON.stringify(patches) })
        .where(and(eq(workspaceDrafts.userId, userId), eq(workspaceDrafts.surfaceId, draft.surfaceId), eq(workspaceDrafts.deviceClass, draft.deviceClass), eq(workspaceDrafts.id, draft.id)));
    }
    await tx.insert(workspaceFlowSettings).values({ userId, enabled: false, updatedAt: Date.now() }).onConflictDoUpdate({ target: workspaceFlowSettings.userId, set: { enabled: false, updatedAt: Date.now() } });
  });
}

/** Who collects and where, with the newest local evidence per scope: what the daily snapshot looks at. */
export async function flowSnapshotCandidates(since: number): Promise<{ userId: number; surfaceId: string; deviceClass: string; newestEvidenceAt: number | null }[]> {
  const rows = await q<{ user_id: number; surface_id: string; device_class: string; newest: string | null }>(`
    SELECT e.user_id, e.surface_id, e.device_class,
      (SELECT max(a.created_at) FROM workspace_flow_aggregates a WHERE a.user_id = e.user_id AND a.surface_id = e.surface_id AND a.device_class = e.device_class AND a.origin = 'local') AS newest
    FROM workspace_flow_events e JOIN workspace_flow_settings s ON s.user_id = e.user_id AND s.enabled
    WHERE e.occurred_at >= ?
    GROUP BY e.user_id, e.surface_id, e.device_class`, since);
  return rows.map(row => ({ userId: Number(row.user_id), surfaceId: row.surface_id, deviceClass: row.device_class, newestEvidenceAt: row.newest === null ? null : Number(row.newest) }));
}
