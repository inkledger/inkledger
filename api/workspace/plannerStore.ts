import { t } from "@contracts/i18n";
import { and, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { workspaceDrafts, workspaceImports, workspacePlannerFeedback } from "@db/schema";
import { getDb } from "../queries/connection";
import type { Draft, Scope } from "@contracts/workspace/model";
import type { WorkspaceDocument } from "@contracts/workspace/portability";
import { isExpectedDraft, lockedDraft, supersededBy } from "./store";
import { draftSchema } from "./validation";

export async function plannerFeedback(userId: number): Promise<{ suppressedSuggestionSignatures: string[] }> {
  const rows = await getDb().select().from(workspacePlannerFeedback).where(eq(workspacePlannerFeedback.userId, userId));
  return { suppressedSuggestionSignatures: rows.map(row => row.signature).sort() };
}

export async function suppressPlannerSuggestion(userId: number, signature: string): Promise<void> {
  await getDb().insert(workspacePlannerFeedback).values({ userId, signature, updatedAt: Date.now() }).onConflictDoNothing();
}

/** Quarantined imports kept per user and scope: the newest ones; an import whose draft is still open is never dropped. */
const MAX_IMPORTS_PER_SCOPE = 20;

export async function quarantineWorkspace(userId: number, id: string, draft: Draft, document: WorkspaceDocument, hasUnknownContent: boolean, expected: Draft | null): Promise<void> {
  const validated = draftSchema.parse(draft);
  await getDb().transaction(async tx => {
    const current = await lockedDraft(tx, userId, draft.scope);
    if (!isExpectedDraft(current, expected) || supersededBy(current, draft)) {
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
    await tx.execute(sql`DELETE FROM workspace_imports i WHERE i.user_id = ${userId} AND i.surface_id = ${draft.scope.surfaceId} AND i.device_class = ${draft.scope.deviceClass}
      AND i.id NOT IN (SELECT id FROM workspace_imports WHERE user_id = ${userId} AND surface_id = ${draft.scope.surfaceId} AND device_class = ${draft.scope.deviceClass} ORDER BY created_at DESC, id DESC LIMIT ${MAX_IMPORTS_PER_SCOPE})
      AND NOT EXISTS (SELECT 1 FROM workspace_drafts d WHERE d.user_id = i.user_id AND d.surface_id = i.surface_id AND d.device_class = i.device_class AND d.id = i.draft_id AND d.status NOT IN ('applied', 'discarded', 'aborted'))`);
  });
}

export async function importHasUnknownContent(userId: number, scope: Scope, draftId: string): Promise<boolean> {
  const rows = await getDb().select({ hasUnknownContent: workspaceImports.hasUnknownContent }).from(workspaceImports).where(and(eq(workspaceImports.userId, userId), eq(workspaceImports.draftId, draftId), eq(workspaceImports.surfaceId, scope.surfaceId), eq(workspaceImports.deviceClass, scope.deviceClass))).limit(1);
  return rows[0]?.hasUnknownContent ?? false;
}
