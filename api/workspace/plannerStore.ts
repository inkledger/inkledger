import { t } from "@contracts/i18n";
import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { workspaceDrafts, workspaceImports, workspacePlannerFeedback } from "@db/schema";
import { getDb } from "../queries/connection";
import type { Draft, Scope } from "@contracts/workspace/model";
import type { WorkspaceDocument } from "@contracts/workspace/portability";
import { samePatches } from "./store";
import { draftSchema } from "./validation";

export async function plannerFeedback(userId: number): Promise<{ suppressedSuggestionSignatures: string[] }> {
  const rows = await getDb().select().from(workspacePlannerFeedback).where(eq(workspacePlannerFeedback.userId, userId));
  return { suppressedSuggestionSignatures: rows.map(row => row.signature).sort() };
}

export async function suppressPlannerSuggestion(userId: number, signature: string): Promise<void> {
  await getDb().insert(workspacePlannerFeedback).values({ userId, signature, updatedAt: Date.now() }).onConflictDoNothing();
}

export async function quarantineWorkspace(userId: number, id: string, draft: Draft, document: WorkspaceDocument, hasUnknownContent: boolean, expected: Draft | null): Promise<void> {
  const validated = draftSchema.parse(draft);
  await getDb().transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`draft:${userId}:${draft.scope.surfaceId}:${draft.scope.deviceClass}`}, 0))`);
    const rows = await tx.select().from(workspaceDrafts)
      .where(and(eq(workspaceDrafts.userId, userId), eq(workspaceDrafts.surfaceId, draft.scope.surfaceId), eq(workspaceDrafts.deviceClass, draft.scope.deviceClass)))
      .orderBy(desc(workspaceDrafts.updatedAt)).limit(1);
    const current = rows[0];
    const matches = current && expected && current.id === expected.draftId && current.draftRevision === expected.draftRevision && current.status === expected.status && samePatches(current.patches, expected.patches);
    if ((expected === null && current) || (expected !== null && !matches) || (current && !["applied", "discarded", "aborted"].includes(current.status) && current.id !== draft.draftId && draft.draftRevision <= current.draftRevision)) {
      throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.changed") });
    }
    await tx.insert(workspaceImports).values({ id, userId, surfaceId: draft.scope.surfaceId, deviceClass: draft.scope.deviceClass, draftId: draft.draftId, document: JSON.stringify(document), hasUnknownContent });
    await tx.insert(workspaceDrafts).values({
      id: validated.draftId,
      userId,
      surfaceId: validated.scope.surfaceId,
      deviceClass: validated.scope.deviceClass,
      baseRevision: validated.baseRevision,
      draftRevision: validated.draftRevision,
      status: validated.status,
      patches: JSON.stringify(validated.patches),
      updatedAt: Math.max(Date.now(), (current?.updatedAt ?? 0) + 1),
    });
  });
}

export async function importHasUnknownContent(userId: number, scope: Scope, draftId: string): Promise<boolean> {
  const rows = await getDb().select({ hasUnknownContent: workspaceImports.hasUnknownContent }).from(workspaceImports).where(and(eq(workspaceImports.userId, userId), eq(workspaceImports.draftId, draftId), eq(workspaceImports.surfaceId, scope.surfaceId), eq(workspaceImports.deviceClass, scope.deviceClass))).limit(1);
  return rows[0]?.hasUnknownContent ?? false;
}
