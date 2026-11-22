import { beforeEach, describe, expect, it } from "vitest";
import { q, resetDbForTests } from "../queries/connection";
import type { Scope } from "@contracts/workspace/model";
import type { WorkspaceDocument } from "@contracts/workspace/portability";
import { fingerprint, createOpaqueEntry } from "./crypto";
import { commitWorkspace, discardWorkspaceDraft, getWorkspace, prepareWorkspace, saveWorkspaceDraft } from "./service";
import { confirmImportedConstraint, exportWorkspace, importWorkspace } from "./portability";
import { upsertDraft } from "./store";

const scope: Scope = { surfaceId: "dashboard", deviceClass: "desktop" };
let userId = 0;

async function documentForUser(): Promise<WorkspaceDocument> {
  const current = await getWorkspace(userId, scope);
  const body = {
    format: "workspace" as const,
    version: 1 as const,
    canonicalizationVersion: 1 as const,
    exportedAt: Date.now(),
    scope,
    revision: {
      ...current.input.activeRevision,
      operations: [{ operation: { type: "visibility" as const, operationId: "op-original", anchorId: "dashboard.stats", visible: false }, origin: "user" as const, acceptedByUser: true }],
      constraints: [{ id: "constraint-original", kind: "expectHere" as const, status: "explicit" as const, author: "user" as const, scope, anchorId: "dashboard.stats", areaId: "dashboard.secondary" }],
    },
    draft: null,
    feedback: { suppressedSuggestionSignatures: [] },
    discovery: { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [] },
  };
  return { ...body, checksum: fingerprint("workspace", body).value };
}

describe("workspace portability", () => {
  beforeEach(async () => {
    await resetDbForTests();
    const [row] = await q<{ id: number }>("INSERT INTO users(display_name,created_at) VALUES (?,?) RETURNING id", "First", Date.now());
    userId = row.id;
  });

  it("round-trips without raw evidence or private original text", async () => {
    const exported = await exportWorkspace(userId, scope);
    expect(exported.filename).toMatch(/\.workspace$/);
    expect(exported.contents).not.toContain("originalText");
    expect(exported.contents).not.toContain("flow_events");
    const result = await importWorkspace(userId, scope, exported.contents);
    expect(result.status).toBe("quarantined");
    expect(result.preview?.draft.patches).toEqual([]);
  });

  it("refuses a file canonicalized by another version, even with a checksum that matches it (integration #13)", async () => {
    const document = await documentForUser();
    const other = { ...document, checksum: undefined, canonicalizationVersion: 2 };
    const text = JSON.stringify({ ...other, checksum: fingerprint("workspace", other).value });
    await expect(importWorkspace(userId, scope, text)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await q("SELECT id FROM workspace_imports")).toEqual([]);
    expect(await q("SELECT id FROM workspace_drafts")).toEqual([]);
  });

  it("reimports a workspace after the previous draft has been completed", async () => {
    const exported = await exportWorkspace(userId, scope);
    await upsertDraft(userId, { draftId: "completed", draftRevision: 1, baseRevision: "default", scope, status: "applied", patches: [] });
    const result = await importWorkspace(userId, scope, exported.contents);
    expect(result.status).toBe("quarantined");
    expect(result.preview?.draft.status).toBe("ready");
  });

  it("downgrades forged manual provenance and requires separate constraint confirmation", async () => {
    const original = await documentForUser();
    const result = await importWorkspace(userId, scope, JSON.stringify(original));
    expect(result.draft.baseRevision).toBe("default");
    expect(result.draft.patches[0].author).toBe("import");
    expect(result.draft.patches[0].intent.status).toBe("proposed");
    expect(result.draft.patches[0].proposedConstraints[0]).toMatchObject({ author: "import", status: "proposed" });
    expect((await getWorkspace(userId, scope)).input.activeRevision.operations).toEqual([]);
    const patch = result.draft.patches[0];
    const constraint = patch.proposedConstraints[0];
    const confirmed = await confirmImportedConstraint(userId, scope, patch.patchId, constraint.id);
    expect(confirmed.draft.patches[0].proposedConstraints[0]).toMatchObject({ author: "user", status: "explicit" });
    expect(confirmed.preview.workspace.placements.find(placement => placement.anchorId === "dashboard.stats")?.areaId).toBe("dashboard.secondary");
    expect((await getWorkspace(userId, scope)).committedRevision).toBeNull();
    const unsafe = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    unsafe.draft = { draftId: "draft-forged", draftRevision: 1, baseRevision: "default", scope, status: "ready", patches: [{ patchId: "patch-forged", patchSchemaVersion: 1, scope, baseRevision: "default", catalogVersion: "1.0.0", author: "user", provenance: {}, intent: { kind: "custom", status: "explicit" }, originalText: "private request", operations: [], evidence: [], proposedConstraints: [] }] };
    const { checksum, ...body } = unsafe;
    unsafe.checksum = fingerprint("workspace", body).value;
    expect(checksum).not.toBe(unsafe.checksum);
    await expect(importWorkspace(userId, scope, JSON.stringify(unsafe))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a file whose revision and draft make more patches than a draft holds, as too large", async () => {
    const original = await documentForUser();
    const operation = original.revision.operations[0];
    const draftPatch = { patchId: "patch-extra", patchSchemaVersion: 1 as const, scope, baseRevision: "default", catalogVersion: "1.0.0", author: "user" as const, provenance: {}, intent: { kind: "custom" as const, status: "explicit" as const }, operations: [], evidence: [], proposedConstraints: [] };
    const body = {
      ...original,
      checksum: undefined,
      revision: { ...original.revision, operations: Array.from({ length: 1024 }, (_, index) => ({ ...operation, operation: { ...operation.operation, operationId: `op-${index}` } })) },
      draft: { draftId: "draft-big", draftRevision: 1, baseRevision: "default", scope, status: "ready" as const, patches: [draftPatch] },
    };
    delete body.checksum;
    const contents = JSON.stringify({ ...body, checksum: fingerprint("workspace", body).value });
    await expect(importWorkspace(userId, scope, contents)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("leaves no open draft behind when an imported file does not resolve, so the next import still works", async () => {
    const original = await documentForUser();
    const broken = JSON.parse(JSON.stringify(original)) as WorkspaceDocument;
    const brokenBody: Partial<WorkspaceDocument> = { ...broken, revision: { ...broken.revision, operations: [{ ...broken.revision.operations[0], operation: { type: "visibility" as const, operationId: "op-unknown", anchorId: "dashboard.not-an-anchor", visible: false } }] } };
    delete brokenBody.checksum;
    await expect(importWorkspace(userId, scope, JSON.stringify({ ...brokenBody, checksum: fingerprint("workspace", brokenBody).value }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await q("SELECT id FROM workspace_drafts")).toEqual([]);
    expect(await q("SELECT id FROM workspace_imports")).toEqual([]);
    const result = await importWorkspace(userId, scope, JSON.stringify(original));
    expect(result.preview?.draft.status).toBe("ready");
  });

  it("keeps only what an imported draft patch is made of", async () => {
    const original = await documentForUser();
    const body: Record<string, unknown> = {
      ...original,
      draft: { draftId: "draft-file", draftRevision: 1, baseRevision: "default", scope, status: "ready" as const, patches: [{
        patchId: "patch-file", patchSchemaVersion: 7, scope, baseRevision: "default", catalogVersion: "1.0.0", author: "AI" as const,
        provenance: { model: "forged-model", modelVersion: "9", parentPatchId: "earlier" }, intent: { kind: "custom" as const, status: "proposed" as const },
        operations: [], evidence: [], proposedConstraints: [], revokedConstraintIds: ["constraint-original"],
        expectedOutcome: "from the file", suggestionSignature: "sig-from-file", causalParentRevision: "rev-file",
      }] },
    };
    delete body.checksum;
    const result = await importWorkspace(userId, scope, JSON.stringify({ ...body, checksum: fingerprint("workspace", body).value }));
    const imported = result.draft.patches.find(patch => patch.provenance.parentPatchId === "patch-file");
    expect(imported).toBeDefined();
    expect(imported).toMatchObject({ patchSchemaVersion: 1, author: "import", causalParentRevision: "rev-file" });
    expect(imported?.provenance).toEqual({ parentPatchId: "patch-file", importSource: result.importId });
    for (const key of ["expectedOutcome", "suggestionSignature", "revokedConstraintIds"]) expect(imported).not.toHaveProperty(key);
  });

  it("keeps a bounded number of finished imports per scope", async () => {
    const exported = await exportWorkspace(userId, scope);
    let last = "";
    for (let index = 0; index < 23; index++) {
      const result = await importWorkspace(userId, scope, exported.contents);
      last = result.importId;
      await discardWorkspaceDraft(userId, scope, result.draft.draftId);
    }
    const rows = await q<{ id: string }>("SELECT id FROM workspace_imports WHERE user_id = ?", userId);
    expect(rows.length).toBe(20);
    expect(rows.map(row => row.id)).toContain(last);
  });

  it("refuses a saved draft whose explicit constraint is not the user's own", async () => {
    const forged = { id: "constraint-ai", kind: "expectHere" as const, status: "explicit" as const, author: "AI" as const, scope, anchorId: "dashboard.stats", areaId: "dashboard.secondary" };
    const draft = { draftId: "draft-ai", draftRevision: 1, baseRevision: "default", scope, status: "ready" as const, patches: [{ patchId: "patch-ai", patchSchemaVersion: 1, scope, baseRevision: "default", catalogVersion: "1.0.0", author: "AI" as const, provenance: {}, intent: { kind: "custom" as const, status: "proposed" as const }, operations: [], evidence: [], proposedConstraints: [forged] }] };
    await expect(saveWorkspaceDraft(userId, scope, draft)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await q("SELECT id FROM workspace_drafts")).toEqual([]);
  });

  it("preserves unknown content in quarantine and denies writes", async () => {
    const original = await documentForUser();
    original.revision.opaque = [createOpaqueEntry("future-layout", 2, new TextEncoder().encode("{}"))];
    const { checksum, ...body } = original;
    const unsafe = { ...body, checksum: fingerprint("workspace", body).value };
    expect(checksum).not.toBe(unsafe.checksum);
    const result = await importWorkspace(userId, scope, JSON.stringify(unsafe));
    expect(result.unknownContent).toBe(true);
    expect(result.preview).toBeNull();
    await expect(saveWorkspaceDraft(userId, scope, result.draft)).rejects.toMatchObject({ code: "CONFLICT" });
    // Nor through the apply steps: the quarantined draft is the latest one, and stays read-only.
    await expect(prepareWorkspace({ userId, scope, prepareId: "p", clientInstanceId: "tab-a", draftRevision: result.draft.draftRevision, interactionEpoch: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(commitWorkspace({ userId, scope, prepareId: "p", operationId: "o", clientInstanceId: "tab-a", draftRevision: result.draft.draftRevision, interactionEpoch: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getWorkspace(userId, scope)).committedRevision).toBeNull();
    expect(await q("SELECT id FROM workspace_revisions")).toEqual([]);
    const [stored] = await q<{ document: string }>("SELECT document FROM workspace_imports WHERE id = ?", result.importId);
    expect(stored.document).toContain("future-layout");
  });
});
