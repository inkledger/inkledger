import { t } from "@contracts/i18n";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import { CANONICALIZATION_VERSION } from "@contracts/workspace/versions";
import type { Constraint, Draft, Scope, SuggestionPatch } from "@contracts/workspace/model";
import { WORKSPACE_FORMAT_VERSION, type WorkspaceDocument } from "@contracts/workspace/portability";
import { fingerprint } from "./crypto";
import { getWorkspace, saveWorkspaceDraft } from "./service";
import { activeRevisionSchema, draftSchema, workspaceInputSchemas } from "./validation";
import { quarantineWorkspace } from "./plannerStore";
import { latestDraft } from "./store";

const documentSchema = z.strictObject({
  format: z.literal("workspace"),
  version: z.literal(WORKSPACE_FORMAT_VERSION),
  canonicalizationVersion: z.literal(CANONICALIZATION_VERSION),
  exportedAt: z.number().int().nonnegative(),
  scope: workspaceInputSchemas.scope,
  revision: activeRevisionSchema,
  draft: draftSchema.nullable(),
  feedback: z.strictObject({ suppressedSuggestionSignatures: z.array(z.string().min(1).max(256)).max(128).readonly() }),
  discovery: z.strictObject({
    seenAnchorIds: z.array(z.string().min(1).max(128)).max(128).readonly(),
    placedAnchorIds: z.array(z.string().min(1).max(128)).max(128).readonly(),
    dismissedAnchorIds: z.array(z.string().min(1).max(128)).max(128).readonly(),
    seenAreaIds: z.array(z.string().min(1).max(128)).max(128).readonly().optional(),
    placedAreaIds: z.array(z.string().min(1).max(128)).max(128).readonly().optional(),
    dismissedAreaIds: z.array(z.string().min(1).max(128)).max(128).readonly().optional(),
  }),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
});

export async function exportWorkspace(userId: number, scope: Scope) {
  const current = await getWorkspace(userId, scope);
  const body = {
    format: "workspace" as const,
    version: 1 as const,
    canonicalizationVersion: 1 as const,
    exportedAt: Date.now(),
    scope,
    revision: current.input.activeRevision,
    draft: current.draft,
    feedback: current.input.feedback,
    discovery: current.input.discoveryState,
  };
  const document: WorkspaceDocument = { ...body, checksum: fingerprint("workspace", body).value };
  return { filename: `workspace-${scope.surfaceId}.workspace`, contents: JSON.stringify(documentSchema.parse(document), null, 2) };
}

export async function importWorkspace(userId: number, scope: Scope, text: string) {
  if (text.length > 512_000) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: t("server.workspace.tooLarge") });
  let document: WorkspaceDocument;
  try {
    const { checksum, ...body } = documentSchema.parse(JSON.parse(text));
    if (fingerprint("workspace", body).value !== checksum) throw new Error("Checksum mismatch");
    document = { ...body, checksum };
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: t("server.workspace.invalidFile") });
  }
  if (document.scope.surfaceId !== scope.surfaceId || document.scope.deviceClass !== scope.deviceClass || document.revision.scope.surfaceId !== scope.surfaceId || document.revision.scope.deviceClass !== scope.deviceClass) {
    throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.invalidRequest") });
  }
  if (document.revision.operations.length > 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: t("server.workspace.invalidRequest") });
  const current = await getWorkspace(userId, scope);
  const importId = `import_${randomUUID()}`;
  const constraints: Constraint[] = document.revision.constraints.map(constraint => ({
    ...constraint,
    id: `constraint_${randomUUID()}`,
    author: "import",
    status: "proposed",
    scope,
  }));
  const patches: SuggestionPatch[] = [];
  for (let index = 0; index < document.revision.operations.length; index += 32) {
    patches.push({
      patchId: `patch_${randomUUID()}`,
      patchSchemaVersion: 1,
      scope,
      baseRevision: current.workspace.sourceActiveRevision,
      catalogVersion: CATALOG_V1.catalogVersion,
      author: "import",
      provenance: { importSource: importId },
      intent: { kind: "custom", status: "proposed" },
      operations: document.revision.operations.slice(index, index + 32).map(committed => ({ ...committed.operation, operationId: `op_${randomUUID()}` })),
      evidence: [],
      proposedConstraints: index === 0 ? constraints : [],
      causalParentRevision: document.revision.revisionId,
    });
  }
  for (const patch of document.draft?.patches ?? []) {
    if (patch.scope.surfaceId !== scope.surfaceId || patch.scope.deviceClass !== scope.deviceClass) throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.invalidRequest") });
    patches.push({
      ...patch,
      patchId: `patch_${randomUUID()}`,
      scope,
      baseRevision: current.workspace.sourceActiveRevision,
      catalogVersion: CATALOG_V1.catalogVersion,
      author: "import",
      provenance: { ...patch.provenance, parentPatchId: patch.patchId, importSource: importId },
      intent: { ...patch.intent, status: "proposed" },
      operations: patch.operations.map(operation => ({ ...operation, operationId: `op_${randomUUID()}` })),
      proposedConstraints: patch.proposedConstraints.map(constraint => ({ ...constraint, id: `constraint_${randomUUID()}`, author: "import", status: "proposed", scope })),
      evidence: [],
    });
  }
  const draft: Draft = {
    draftId: `draft_${randomUUID()}`,
    draftRevision: 1,
    baseRevision: current.workspace.sourceActiveRevision,
    scope,
    patches,
    status: "editing",
  };
  const unknownContent = document.revision.opaque.length > 0;
  await quarantineWorkspace(userId, importId, draft, document, unknownContent, await latestDraft(userId, scope));
  return { importId, status: "quarantined" as const, unknownContent, draft, preview: unknownContent ? null : await saveWorkspaceDraft(userId, scope, draft) };
}

export async function confirmImportedConstraint(userId: number, scope: Scope, patchId: string, constraintId: string) {
  const current = await getWorkspace(userId, scope);
  if (!current.draft) throw new TRPCError({ code: "NOT_FOUND", message: t("server.workspace.gone") });
  let found = false;
  const draft: Draft = {
    ...current.draft,
    draftRevision: current.draft.draftRevision + 1,
    patches: current.draft.patches.map(patch => ({
      ...patch,
      proposedConstraints: patch.proposedConstraints.map(constraint => {
        if (patch.patchId !== patchId || constraint.id !== constraintId) return constraint;
        if (constraint.author !== "import" && constraint.author !== "AI") throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.noConfirmation") });
        found = true;
        return { ...constraint, author: "user" as const, status: "explicit" as const, scope };
      }),
    })),
  };
  if (!found) throw new TRPCError({ code: "NOT_FOUND", message: t("server.workspace.gone") });
  return saveWorkspaceDraft(userId, scope, draft);
}
