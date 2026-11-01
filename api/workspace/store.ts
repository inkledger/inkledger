import { and, desc, eq, lt, sql } from "drizzle-orm";
import { WorkspaceApplyError } from "@contracts/workspace/applyMachine";
import { canonicalJSON } from "@contracts/workspace/canonical";
import { APPLY_POLICY_V1 } from "@contracts/workspace/versions";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  workspaceDescriptors,
  workspaceDrafts,
  workspaceImports,
  workspaceOperations,
  workspacePrepared,
  workspacePresentations,
  workspaceRevisions,
} from "@db/schema";
import { getDb } from "../queries/connection";
import type { ApplyState, PresentationState, PreparedRevision } from "@contracts/workspace/applyMachine";
import type { ActiveRevision, Draft, PresentationDescriptor, Scope } from "@contracts/workspace/model";
import {
  activeRevisionSchema,
  draftSchema,
  presentationDescriptorSchema,
  presentationStateSchema,
  preparedRevisionSchema,
  type ValidatedActiveRevision,
  type ValidatedDescriptor,
  type ValidatedDraft,
  type ValidatedPresentation,
  type ValidatedPrepared,
} from "./validation";

/** The scopes the user ever committed a layout for ("surface:device"): only those run the workspace runtime. */
export async function customizedScopes(userId: number): Promise<string[]> {
  const rows = await getDb().selectDistinct({ surfaceId: workspaceRevisions.surfaceId, deviceClass: workspaceRevisions.deviceClass })
    .from(workspaceRevisions).where(eq(workspaceRevisions.userId, userId));
  return rows.map(row => `${row.surfaceId}:${row.deviceClass}`).sort();
}

type RowRevision = typeof workspaceRevisions.$inferSelect;
type RowDraft = typeof workspaceDrafts.$inferSelect;
type RowDescriptor = typeof workspaceDescriptors.$inferSelect;
type RowPresentation = typeof workspacePresentations.$inferSelect;
type RowPrepared = typeof workspacePrepared.$inferSelect;

const parseJson = (text: string): unknown => JSON.parse(text) as unknown;

function scopeWhere(scope: Scope) {
  return (table: { surfaceId: AnyPgColumn; deviceClass: AnyPgColumn }) =>
    and(eq(table.surfaceId, scope.surfaceId), eq(table.deviceClass, scope.deviceClass));
}

function revisionOf(row: RowRevision): ActiveRevision {
  return activeRevisionSchema.parse({
    revisionId: row.id,
    scope: { surfaceId: row.surfaceId, deviceClass: row.deviceClass },
    catalogVersion: row.catalogVersion,
    productDefaultVersion: row.productDefaultVersion,
    committedAt: row.committedAt,
    operations: parseJson(row.operations),
    constraints: parseJson(row.constraints),
    ...(row.causedByRevision ? { causedByRevision: row.causedByRevision } : {}),
    opaque: parseJson(row.opaque),
  });
}

function draftOf(row: RowDraft): Draft {
  return draftSchema.parse({
    draftId: row.id,
    draftRevision: row.draftRevision,
    baseRevision: row.baseRevision,
    scope: { surfaceId: row.surfaceId, deviceClass: row.deviceClass },
    patches: parseJson(row.patches),
    status: row.status,
  });
}

function descriptorOf(row: RowDescriptor): PresentationDescriptor {
  return presentationDescriptorSchema.parse(parseJson(row.descriptor));
}

function presentationOf(row: RowPresentation): PresentationState {
  return presentationStateSchema.parse({
    clientInstanceId: row.clientInstanceId,
    status: row.status,
    lastIssuedEpoch: row.lastIssuedEpoch,
    ...(row.presentedDescriptor ? { presented: { descriptor: parseJson(row.presentedDescriptor), presentationEpoch: row.presentedEpoch } } : {}),
    ...(row.pending ? { pending: parseJson(row.pending) } : {}),
  });
}

function preparedOf(row: RowPrepared): PreparedRevision {
  return preparedRevisionSchema.parse({
    prepareId: row.prepareId,
    clientInstanceId: row.clientInstanceId,
    baseRevision: row.baseRevision,
    draftRevision: row.draftRevision,
    interactionEpoch: row.interactionEpoch,
    descriptor: parseJson(row.descriptor),
    expiresAt: row.expiresAt,
  });
}

export async function latestRevision(userId: number, scope: Scope): Promise<ActiveRevision | null> {
  const rows = await getDb().select().from(workspaceRevisions)
    .where(and(eq(workspaceRevisions.userId, userId), scopeWhere(scope)(workspaceRevisions), eq(workspaceRevisions.status, "committed")))
    .orderBy(desc(workspaceRevisions.revisionNumber)).limit(1);
  return rows[0] ? revisionOf(rows[0]) : null;
}

export async function revisionById(userId: number, scope: Scope, revisionId: string): Promise<ActiveRevision | null> {
  const rows = await getDb().select().from(workspaceRevisions)
    .where(and(eq(workspaceRevisions.userId, userId), scopeWhere(scope)(workspaceRevisions), eq(workspaceRevisions.id, revisionId)))
    .limit(1);
  return rows[0] ? revisionOf(rows[0]) : null;
}

export async function latestDraft(userId: number, scope: Scope): Promise<Draft | null> {
  const rows = await getDb().select().from(workspaceDrafts)
    .where(and(eq(workspaceDrafts.userId, userId), scopeWhere(scope)(workspaceDrafts)))
    .orderBy(desc(workspaceDrafts.updatedAt)).limit(1);
  return rows[0] ? draftOf(rows[0]) : null;
}

/** The stored patches are the expected ones: compared by content, so how the JSON text is spaced never matters. */
export function samePatches(stored: string, expected: Draft["patches"]): boolean {
  try {
    return canonicalJSON(JSON.parse(stored)) === canonicalJSON(expected);
  } catch {
    return false;
  }
}

export async function upsertDraft(userId: number, draft: Draft, expected?: Draft | null): Promise<void> {
  const validated = draftSchema.parse(draft);
  await getDb().transaction(async tx => {
    const scope = validated.scope;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`draft:${userId}:${scope.surfaceId}:${scope.deviceClass}`}, 0))`);
    const rows = await tx.select().from(workspaceDrafts)
      .where(and(eq(workspaceDrafts.userId, userId), scopeWhere(scope)(workspaceDrafts)))
      .orderBy(desc(workspaceDrafts.updatedAt)).limit(1);
    const current = rows[0];
    if (expected !== undefined) {
      const matches = current && expected && current.id === expected.draftId && current.draftRevision === expected.draftRevision && current.status === expected.status && samePatches(current.patches, expected.patches);
      if ((expected === null && current) || (expected !== null && !matches)) throw new WorkspaceApplyError("draft-concurrent-modification");
      if (current && !["applied", "discarded", "aborted"].includes(current.status) && current.id !== validated.draftId && validated.draftRevision <= current.draftRevision) {
        throw new WorkspaceApplyError("draft-revision-conflict");
      }
    }
    const updatedAt = Math.max(Date.now(), (current?.updatedAt ?? 0) + 1);
    await tx.insert(workspaceDrafts).values({
      id: validated.draftId,
      userId,
      surfaceId: scope.surfaceId,
      deviceClass: scope.deviceClass,
      baseRevision: validated.baseRevision,
      draftRevision: validated.draftRevision,
      status: validated.status,
      patches: JSON.stringify(validated.patches),
      updatedAt,
    }).onConflictDoUpdate({
      target: [workspaceDrafts.userId, workspaceDrafts.surfaceId, workspaceDrafts.deviceClass, workspaceDrafts.id],
      set: {
        baseRevision: validated.baseRevision,
        draftRevision: validated.draftRevision,
        status: validated.status,
        patches: JSON.stringify(validated.patches),
        updatedAt,
      },
    });
  });
}

async function insertDescriptor(tx: Tx | ReturnType<typeof getDb>, userId: number, scope: Scope, descriptor: PresentationDescriptor): Promise<void> {
  const validated = presentationDescriptorSchema.parse(descriptor);
  await tx.insert(workspaceDescriptors).values({
    effectiveRevision: validated.effectiveRevision,
    userId,
    surfaceId: scope.surfaceId,
    deviceClass: scope.deviceClass,
    sourceActiveRevision: validated.sourceActiveRevision,
    workspaceFingerprint: validated.workspaceFingerprint,
    descriptor: JSON.stringify(validated),
  }).onConflictDoNothing();
}

export async function saveDescriptor(userId: number, scope: Scope, descriptor: PresentationDescriptor): Promise<void> {
  await insertDescriptor(getDb(), userId, scope, descriptor);
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** The lock every apply transition of one user's scope takes, commit included. */
async function lockApply(tx: Tx, userId: number, scope: Scope): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${scope.surfaceId}:${scope.deviceClass}`}, 0))`);
}

const samePresentation = (a: PresentationState | null, b: PresentationState | null) =>
  JSON.stringify(a && presentationStateSchema.parse(a)) === JSON.stringify(b && presentationStateSchema.parse(b));

/**
 * Writes one client's presentation only while it is still the one the transition started from:
 * a concurrent activate, ack or commit makes this one fail instead of being silently undone.
 */
async function swapPresentation(tx: Tx, userId: number, scope: Scope, expected: PresentationState | null, next: PresentationState): Promise<void> {
  const validated = presentationStateSchema.parse(next);
  const rows = await tx.select().from(workspacePresentations)
    .where(and(eq(workspacePresentations.userId, userId), scopeWhere(scope)(workspacePresentations), eq(workspacePresentations.clientInstanceId, validated.clientInstanceId)))
    .limit(1);
  if (!samePresentation(rows[0] ? presentationOf(rows[0]) : null, expected)) throw new WorkspaceApplyError("presentation-concurrent-modification");
  const values = {
    status: validated.status,
    lastIssuedEpoch: validated.lastIssuedEpoch,
    presentedDescriptor: validated.presented ? JSON.stringify(validated.presented.descriptor) : null,
    presentedEpoch: validated.presented?.presentationEpoch ?? null,
    pending: validated.pending ? JSON.stringify(validated.pending) : null,
    updatedAt: Date.now(),
  };
  await tx.insert(workspacePresentations).values({
    userId,
    clientInstanceId: validated.clientInstanceId,
    surfaceId: scope.surfaceId,
    deviceClass: scope.deviceClass,
    ...values,
  }).onConflictDoUpdate({
    target: [workspacePresentations.userId, workspacePresentations.clientInstanceId, workspacePresentations.surfaceId, workspacePresentations.deviceClass],
    set: values,
  });
}

export async function writePresentation(userId: number, scope: Scope, expected: PresentationState | null, next: PresentationState, descriptor?: PresentationDescriptor): Promise<void> {
  await getDb().transaction(async tx => {
    await lockApply(tx, userId, scope);
    if (descriptor) await insertDescriptor(tx, userId, scope, descriptor);
    await swapPresentation(tx, userId, scope, expected, next);
  });
}

export async function upsertPrepared(userId: number, scope: Scope, prepared: PreparedRevision): Promise<void> {
  const validated = preparedRevisionSchema.parse(prepared);
  await getDb().insert(workspacePrepared).values({
    prepareId: validated.prepareId,
    userId,
    surfaceId: scope.surfaceId,
    deviceClass: scope.deviceClass,
    baseRevision: validated.baseRevision,
    draftRevision: validated.draftRevision,
    clientInstanceId: validated.clientInstanceId,
    interactionEpoch: validated.interactionEpoch,
    descriptor: JSON.stringify(validated.descriptor),
    expiresAt: validated.expiresAt,
  }).onConflictDoUpdate({
    target: [workspacePrepared.userId, workspacePrepared.surfaceId, workspacePrepared.deviceClass, workspacePrepared.prepareId],
    set: {
      baseRevision: validated.baseRevision,
      draftRevision: validated.draftRevision,
      clientInstanceId: validated.clientInstanceId,
      interactionEpoch: validated.interactionEpoch,
      descriptor: JSON.stringify(validated.descriptor),
      expiresAt: validated.expiresAt,
    },
  });
}

export async function deletePrepared(userId: number, scope: Scope, prepareId: string): Promise<void> {
  await getDb().delete(workspacePrepared).where(and(eq(workspacePrepared.userId, userId), scopeWhere(scope)(workspacePrepared), eq(workspacePrepared.prepareId, prepareId)));
}

/** One scope's apply state; `prepareId` picks that prepared revision (each tab has its own), else none. */
export async function loadApplyState(userId: number, scope: Scope, prepareId?: string): Promise<ApplyState> {
  const db = getDb();
  const where = scopeWhere(scope);
  const [revisionRows, preparedRows, presentationRows, operationRows, descriptorRows] = await Promise.all([
    db.select().from(workspaceRevisions).where(and(eq(workspaceRevisions.userId, userId), where(workspaceRevisions))).orderBy(workspaceRevisions.revisionNumber),
    prepareId === undefined
      ? Promise.resolve([])
      : db.select().from(workspacePrepared).where(and(eq(workspacePrepared.userId, userId), where(workspacePrepared), eq(workspacePrepared.prepareId, prepareId))).limit(1),
    db.select().from(workspacePresentations).where(and(eq(workspacePresentations.userId, userId), where(workspacePresentations))),
    db.select().from(workspaceOperations).where(and(eq(workspaceOperations.userId, userId), where(workspaceOperations))),
    db.select().from(workspaceDescriptors).where(and(eq(workspaceDescriptors.userId, userId), where(workspaceDescriptors))),
  ]);
  const committed = revisionRows.at(-1);
  const committedDescriptorRow = committed
    ? descriptorRows.filter(row => row.sourceActiveRevision === committed.id).sort((a, b) => b.createdAt - a.createdAt || (a.effectiveRevision < b.effectiveRevision ? 1 : a.effectiveRevision > b.effectiveRevision ? -1 : 0))[0]
    : undefined;
  return {
    scope,
    committedRevision: committed?.id ?? null,
    committedDescriptor: committedDescriptorRow ? descriptorOf(committedDescriptorRow) : null,
    prepared: preparedRows[0] ? preparedOf(preparedRows[0]) : null,
    presentations: Object.fromEntries(presentationRows.map(row => [row.clientInstanceId, presentationOf(row)])),
    history: revisionRows.length > 0 ? ["default", ...revisionRows.map(row => row.id)] : [],
    operationIds: operationRows.map(row => row.operationId),
    descriptors: Object.fromEntries(descriptorRows.map(row => [row.effectiveRevision, descriptorOf(row)])),
  };
}

export async function commitRevision(input: {
  userId: number;
  scope: Scope;
  revision: ActiveRevision;
  descriptor: PresentationDescriptor;
  presentation: PresentationState;
  /** The client's presentation the commit was computed from (null: none stored yet). */
  expectedPresentation: PresentationState | null;
  operationId: string;
  prepareId: string;
  baseRevision: string;
  draftId: string | null;
  draftRevision: number;
}): Promise<boolean> {
  const { userId, scope, revision, descriptor, presentation, operationId } = input;
  const validatedRevision = activeRevisionSchema.parse(revision);
  const validatedDescriptor = presentationDescriptorSchema.parse(descriptor);
  const validatedPresentation = presentationStateSchema.parse(presentation);
  return getDb().transaction(async tx => {
    await lockApply(tx, userId, scope);
    const previous = await tx.select({ operationId: workspaceOperations.operationId }).from(workspaceOperations)
      .where(and(eq(workspaceOperations.userId, userId), scopeWhere(scope)(workspaceOperations), eq(workspaceOperations.operationId, operationId))).limit(1);
    if (previous.length > 0) return false;
    const [current, preparedRow, draftRow] = await Promise.all([
      tx.select({ id: workspaceRevisions.id }).from(workspaceRevisions).where(and(eq(workspaceRevisions.userId, userId), scopeWhere(scope)(workspaceRevisions), eq(workspaceRevisions.status, "committed"))).limit(1),
      tx.select().from(workspacePrepared).where(and(eq(workspacePrepared.userId, userId), scopeWhere(scope)(workspacePrepared), eq(workspacePrepared.prepareId, input.prepareId))).limit(1),
      tx.select({ id: workspaceDrafts.id, draftRevision: workspaceDrafts.draftRevision, status: workspaceDrafts.status }).from(workspaceDrafts).where(and(eq(workspaceDrafts.userId, userId), scopeWhere(scope)(workspaceDrafts))).orderBy(desc(workspaceDrafts.updatedAt)).limit(1),
    ]);
    const preparedDescriptor = preparedRow[0] ? presentationDescriptorSchema.parse(parseJson(preparedRow[0].descriptor)) : null;
    // A draft discarded or applied meanwhile is not the one this commit was prepared from.
    const openDraft = draftRow[0] && !["applied", "discarded", "aborted"].includes(draftRow[0].status) ? draftRow[0] : undefined;
    if ((current[0]?.id ?? "default") !== input.baseRevision || !preparedRow[0] || preparedRow[0].baseRevision !== input.baseRevision || preparedRow[0].clientInstanceId !== presentation.clientInstanceId || preparedRow[0].draftRevision !== input.draftRevision || preparedRow[0].expiresAt <= Date.now() || preparedDescriptor?.workspaceFingerprint !== descriptor.workspaceFingerprint || (openDraft?.id ?? null) !== input.draftId || (input.draftId !== null && openDraft?.draftRevision !== input.draftRevision)) {
      throw new WorkspaceApplyError("stale-base");
    }
    await tx.insert(workspaceOperations).values({
      operationId,
      userId,
      surfaceId: scope.surfaceId,
      deviceClass: scope.deviceClass,
      kind: "commit",
      response: JSON.stringify({ revisionId: validatedRevision.revisionId }),
    });
    await tx.insert(workspaceDescriptors).values({
      effectiveRevision: validatedDescriptor.effectiveRevision,
      userId,
      surfaceId: scope.surfaceId,
      deviceClass: scope.deviceClass,
      sourceActiveRevision: validatedDescriptor.sourceActiveRevision,
      workspaceFingerprint: validatedDescriptor.workspaceFingerprint,
      descriptor: JSON.stringify(validatedDescriptor),
    }).onConflictDoNothing();
    await tx.update(workspaceRevisions).set({ status: "superseded" })
      .where(and(eq(workspaceRevisions.userId, userId), scopeWhere(scope)(workspaceRevisions), eq(workspaceRevisions.status, "committed")));
    const previousNumbers = await tx.select({ revisionNumber: workspaceRevisions.revisionNumber }).from(workspaceRevisions).where(and(eq(workspaceRevisions.userId, userId), scopeWhere(scope)(workspaceRevisions)));
    const revisionNumber = validatedRevision.revisionId === "default" ? 0 : previousNumbers.reduce((max, row) => Math.max(max, row.revisionNumber), 0) + 1;
    await tx.insert(workspaceRevisions).values({
      id: validatedRevision.revisionId,
      userId,
      surfaceId: scope.surfaceId,
      deviceClass: scope.deviceClass,
      revisionNumber,
      catalogVersion: validatedRevision.catalogVersion,
      productDefaultVersion: validatedRevision.productDefaultVersion,
      committedAt: validatedRevision.committedAt,
      operations: JSON.stringify(validatedRevision.operations),
      constraints: JSON.stringify(validatedRevision.constraints),
      opaque: JSON.stringify(validatedRevision.opaque),
      causedByRevision: validatedRevision.causedByRevision ?? null,
      status: "committed",
    });
    await swapPresentation(tx, userId, scope, input.expectedPresentation, validatedPresentation);
    await tx.delete(workspacePrepared).where(and(eq(workspacePrepared.userId, userId), scopeWhere(scope)(workspacePrepared), eq(workspacePrepared.prepareId, input.prepareId)));
    return true;
  });
}

/** The scope's saved layouts, oldest first: when each was saved and how many changes it holds (the Studio's history). */
export async function revisionSummaries(userId: number, scope: Scope): Promise<{ revisionId: string; committedAt: number; changes: number }[]> {
  const rows = await getDb().select({ id: workspaceRevisions.id, committedAt: workspaceRevisions.committedAt, operations: workspaceRevisions.operations })
    .from(workspaceRevisions).where(and(eq(workspaceRevisions.userId, userId), scopeWhere(scope)(workspaceRevisions))).orderBy(workspaceRevisions.revisionNumber);
  return rows.map(row => ({ revisionId: row.id, committedAt: row.committedAt, changes: (parseJson(row.operations) as unknown[]).length }));
}

/**
 * A first revision written without a client (the legacy Dashboard layout): only while the scope has
 * none, so running it twice, or after the user customized, changes nothing. No presentation: each
 * tab presents it on its first read.
 */
export async function insertSeedRevision(userId: number, scope: Scope, revision: ActiveRevision, descriptor: PresentationDescriptor): Promise<boolean> {
  const validatedRevision = activeRevisionSchema.parse(revision);
  return getDb().transaction(async tx => {
    await lockApply(tx, userId, scope);
    const existing = await tx.select({ id: workspaceRevisions.id }).from(workspaceRevisions)
      .where(and(eq(workspaceRevisions.userId, userId), scopeWhere(scope)(workspaceRevisions))).limit(1);
    if (existing.length > 0) return false;
    await insertDescriptor(tx, userId, scope, descriptor);
    await tx.insert(workspaceRevisions).values({
      id: validatedRevision.revisionId,
      userId,
      surfaceId: scope.surfaceId,
      deviceClass: scope.deviceClass,
      revisionNumber: 1,
      catalogVersion: validatedRevision.catalogVersion,
      productDefaultVersion: validatedRevision.productDefaultVersion,
      committedAt: validatedRevision.committedAt,
      operations: JSON.stringify(validatedRevision.operations),
      constraints: JSON.stringify(validatedRevision.constraints),
      opaque: JSON.stringify(validatedRevision.opaque),
      causedByRevision: null,
      status: "committed",
    });
    return true;
  });
}

/** The boot purge: expired prepares and presentations left unknown past their retention, for every user. */
/** A tab untouched this long is closed: its presentation goes (an open one makes a new one on its next look). */
const IDLE_PRESENTATION_MS = 7 * 86_400_000;
/** Finished drafts, commit replay records and quarantined imports no open draft uses: kept a month, then dropped. */
const FINISHED_RETENTION_MS = 30 * 86_400_000;

export async function pruneWorkspaceState(now: number): Promise<void> {
  const finishedBefore = now - FINISHED_RETENTION_MS;
  await Promise.all([
    getDb().delete(workspacePrepared).where(lt(workspacePrepared.expiresAt, now)),
    getDb().delete(workspacePresentations).where(and(eq(workspacePresentations.status, "unknown"), lt(workspacePresentations.updatedAt, now - APPLY_POLICY_V1.activationUncertainRetentionMs))),
    getDb().delete(workspacePresentations).where(lt(workspacePresentations.updatedAt, now - IDLE_PRESENTATION_MS)),
    getDb().delete(workspaceOperations).where(lt(workspaceOperations.createdAt, finishedBefore)),
    getDb().delete(workspaceDrafts).where(and(sql`${workspaceDrafts.status} IN ('applied', 'discarded', 'aborted')`, lt(workspaceDrafts.updatedAt, finishedBefore))),
    getDb().delete(workspaceImports).where(and(lt(workspaceImports.createdAt, finishedBefore), sql`NOT EXISTS (SELECT 1 FROM workspace_drafts d WHERE d.user_id = ${workspaceImports.userId} AND d.surface_id = ${workspaceImports.surfaceId} AND d.device_class = ${workspaceImports.deviceClass} AND d.id = ${workspaceImports.draftId} AND d.status NOT IN ('applied', 'discarded', 'aborted'))`)),
  ]);
}

export async function operationResponse(userId: number, scope: Scope, operationId: string): Promise<unknown> {
  const rows = await getDb().select().from(workspaceOperations).where(and(eq(workspaceOperations.userId, userId), scopeWhere(scope)(workspaceOperations), eq(workspaceOperations.operationId, operationId))).limit(1);
  return rows[0] ? parseJson(rows[0].response) : null;
}

export type {
  ValidatedActiveRevision,
  ValidatedDescriptor,
  ValidatedDraft,
  ValidatedPresentation,
  ValidatedPrepared,
};
