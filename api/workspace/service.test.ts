import { beforeEach, describe, expect, it } from "vitest";
import { q, resetDbForTests } from "../queries/connection";
import type { Draft, Scope } from "@contracts/workspace/model";
import {
  acknowledgeWorkspace,
  activateWorkspace,
  commitWorkspace,
  completeWorkspaceDraft,
  discardWorkspaceDraft,
  getWorkspace,
  markWorkspaceDiscovery,
  openWorkspacePage,
  prepareWorkspace,
  reproposeWorkspaceDraft,
  rollbackWorkspace,
  saveWorkspaceDraft,
} from "./service";

const scope: Scope = { surfaceId: "dashboard", deviceClass: "desktop" };

function draft(visible: boolean): Draft {
  return {
    draftId: "draft-1",
    draftRevision: 1,
    baseRevision: "default",
    scope,
    status: "ready",
    patches: [{
      patchId: "patch-manual-1",
      patchSchemaVersion: 1,
      scope,
      baseRevision: "default",
      catalogVersion: "1.0.0",
      author: "user",
      provenance: {},
      intent: { kind: "reduce", status: "explicit", anchorId: "dashboard.stats" },
      operations: [{ type: "visibility", operationId: "op-visibility-1", anchorId: "dashboard.stats", visible }],
      evidence: [],
      proposedConstraints: [],
    }],
  };
}

async function user(): Promise<number> {
  const rows = await q<{ id: number }>("INSERT INTO users(display_name, created_at) VALUES (?, ?) RETURNING id", "Workspace", 1_800_000_000_000);
  return rows[0].id;
}

describe("workspace application service", () => {
  let userId: number;

  beforeEach(async () => {
    await resetDbForTests();
    userId = await user();
  });

  it("never commits a draft another tab discarded after this one prepared it", async () => {
    await saveWorkspaceDraft(userId, scope, draft(false));
    await prepareWorkspace({ userId, scope, prepareId: "prepare-d", clientInstanceId: "tab-a", draftRevision: 1, interactionEpoch: 1 });
    await discardWorkspaceDraft(userId, scope, "draft-1");
    await expect(commitWorkspace({ userId, scope, prepareId: "prepare-d", operationId: "operation-d", clientInstanceId: "tab-a", draftRevision: 1, interactionEpoch: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await q("SELECT COUNT(*)::int AS n FROM workspace_revisions WHERE user_id = ?", userId)).toEqual([{ n: 0 }]);
    expect((await getWorkspace(userId, scope, "tab-b")).workspace.placements.find(placement => placement.anchorId === "dashboard.stats")?.visible).toBe(true);
  });

  it("matches a stored draft by its content, not by how its JSON text is spaced", async () => {
    const first = draft(false);
    await q("INSERT INTO workspace_drafts (id, user_id, surface_id, device_class, base_revision, draft_revision, status, patches, created_at, updated_at) VALUES ('draft-1', ?, 'dashboard', 'desktop', 'default', 1, 'ready', ?, ?, ?)",
      userId, JSON.stringify(first.patches, null, 1), Date.now(), Date.now());
    await saveWorkspaceDraft(userId, scope, { ...draft(true), draftRevision: 2 });
    await discardWorkspaceDraft(userId, scope, "draft-1");
  });

  it("lets the boot purge drop what closed tabs and finished drafts leave behind, never a revision", async () => {
    const { pruneWorkspaceState } = await import("./store");
    await getWorkspace(userId, scope, "tab-old");
    await saveWorkspaceDraft(userId, scope, draft(false));
    await prepareWorkspace({ userId, scope, prepareId: "prepare-old", clientInstanceId: "tab-old", draftRevision: 1, interactionEpoch: 1 });
    await commitWorkspace({ userId, scope, prepareId: "prepare-old", operationId: "operation-old", clientInstanceId: "tab-old", draftRevision: 1, interactionEpoch: 1 });
    await completeWorkspaceDraft(userId, scope, "draft-1", 1);
    const counts = async () => (await q<Record<string, number>>(`SELECT
      (SELECT count(*)::int FROM workspace_presentations WHERE user_id = ?) AS presentations,
      (SELECT count(*)::int FROM workspace_operations WHERE user_id = ?) AS operations,
      (SELECT count(*)::int FROM workspace_drafts WHERE user_id = ?) AS drafts,
      (SELECT count(*)::int FROM workspace_revisions WHERE user_id = ?) AS revisions`, userId, userId, userId, userId))[0];
    const day = 86_400_000;
    await pruneWorkspaceState(Date.now() + day);
    expect(await counts()).toEqual({ presentations: 1, operations: 1, drafts: 1, revisions: 1 });
    await pruneWorkspaceState(Date.now() + 31 * day);
    expect(await counts()).toEqual({ presentations: 0, operations: 0, drafts: 0, revisions: 1 });
  });

  it("keeps both of two discovery marks sent at the same time", async () => {
    const none = { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [] };
    await Promise.all([
      markWorkspaceDiscovery(userId, scope, { ...none, seenAnchorIds: ["dashboard.recap"] }),
      markWorkspaceDiscovery(userId, scope, { ...none, placedAnchorIds: ["dashboard.desk"] }),
    ]);
    const [row] = await q<{ seen_anchor_ids: string; placed_anchor_ids: string }>("SELECT seen_anchor_ids, placed_anchor_ids FROM workspace_discovery WHERE user_id = ?", userId);
    expect(JSON.parse(row.seen_anchor_ids)).toEqual(expect.arrayContaining(["dashboard.desk", "dashboard.recap"]));
    expect(JSON.parse(row.placed_anchor_ids)).toEqual(["dashboard.desk"]);
  });

  it("marks applied only the draft revision that was committed", async () => {
    await saveWorkspaceDraft(userId, scope, draft(false));
    await saveWorkspaceDraft(userId, scope, { ...draft(true), draftRevision: 2 });
    await completeWorkspaceDraft(userId, scope, "draft-1", 1);
    expect((await q<{ status: string }>("SELECT status FROM workspace_drafts WHERE user_id = ?", userId))[0].status).toBe("ready");
  });

  it("starts from ProductDefault without inventing an active revision", async () => {
    const result = await getWorkspace(userId, scope, "tab-a");
    expect(result.committedRevision).toBeNull();
    expect(result.workspace.sourceActiveRevision).toBe("default");
    expect(result.workspace.placements.length).toBeGreaterThan(0);
    expect(result.ssr).toEqual({ kind: "activate", descriptor: result.descriptor });
  });

  it("applies a manual draft through prepare/commit/activate/ack with matching final ids and fresh SSR", async () => {
    const ssrBefore = await getWorkspace(userId, scope, "ssr");
    expect(ssrBefore.workspace.sourceActiveRevision).toBe("default");
    const saved = await saveWorkspaceDraft(userId, scope, draft(false));
    const restored = await getWorkspace(userId, scope, "tab-a");
    expect(restored.draftWorkspace).toEqual(saved.preview.workspace);
    expect(restored.draftDescriptor).toEqual(saved.preview.descriptor);
    expect(restored.workspace.placements.find(placement => placement.anchorId === "dashboard.stats")?.visible).toBe(true);
    const prepared = await prepareWorkspace({
      userId,
      scope,
      prepareId: "prepare-1",
      clientInstanceId: "tab-a",
      draftRevision: 1,
      interactionEpoch: 7,
    });
    expect(prepared.descriptor.sourceActiveRevision).toBe("default");
    const committed = await commitWorkspace({
      userId,
      scope,
      prepareId: "prepare-1",
      operationId: "operation-1",
      clientInstanceId: "tab-a",
      draftRevision: 1,
      interactionEpoch: 7,
    });
    expect(committed.committed).toBe(true);
    expect(committed.leaseToken).not.toBeNull();
    expect(committed.presentation.pending?.descriptor.sourceActiveRevision).toBe(committed.revision!.revisionId);
    const activated = await activateWorkspace({
      userId,
      scope,
      clientInstanceId: "tab-a",
      interactionEpoch: 7,
      leaseToken: committed.leaseToken!,
    });
    expect(activated.presentation.pending?.activationId).toBe(activated.activationId);
    const acknowledged = await acknowledgeWorkspace({
      userId,
      scope,
      clientInstanceId: "tab-a",
      activationId: activated.activationId,
      effectiveRevision: activated.presentation.pending!.descriptor.effectiveRevision,
      workspaceFingerprint: activated.presentation.pending!.descriptor.workspaceFingerprint,
      presentationEpoch: activated.presentation.pending!.presentationEpoch,
    });
    expect(acknowledged.status).toBe("stable");
    expect(acknowledged.presented?.descriptor.sourceActiveRevision).toBe(committed.revision!.revisionId);
    const current = await getWorkspace(userId, scope, "tab-a");
    expect(current.workspace.placements.find(placement => placement.anchorId === "dashboard.stats")?.visible).toBe(false);
    expect(current.committedRevision).toBe(committed.revision!.revisionId);
    expect(current.presentation?.status).toBe("stable");
    const ssrAfter = await getWorkspace(userId, scope, "ssr");
    expect(ssrAfter.descriptor.sourceActiveRevision).toBe(committed.revision!.revisionId);
    expect(ssrAfter.workspace.placements.find(placement => placement.anchorId === "dashboard.stats")?.visible).toBe(false);
    const retry = await commitWorkspace({
      userId,
      scope,
      prepareId: "prepare-1",
      operationId: "operation-1",
      clientInstanceId: "tab-a",
      draftRevision: 1,
      interactionEpoch: 7,
    });
    expect(retry.committed).toBe(false);
    expect(retry.revision?.revisionId).toBe(committed.revision!.revisionId);
    expect(retry.leaseToken).toBeNull();
    expect(current.history).toEqual(["default", committed.revision!.revisionId]);
  });

  it("rejects a commit when the resolved fingerprint changed after prepare", async () => {
    await saveWorkspaceDraft(userId, scope, draft(true));
    await prepareWorkspace({
      userId,
      scope,
      prepareId: "prepare-stale",
      clientInstanceId: "tab-a",
      draftRevision: 1,
      interactionEpoch: 7,
    });
    await saveWorkspaceDraft(userId, scope, { ...draft(false), draftRevision: 2 });
    await expect(commitWorkspace({
      userId,
      scope,
      prepareId: "prepare-stale",
      operationId: "operation-stale",
      clientInstanceId: "tab-a",
      draftRevision: 2,
      interactionEpoch: 7,
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects concurrent drafts that reuse the same revision instead of overwriting intent", async () => {
    const results = await Promise.allSettled([
      saveWorkspaceDraft(userId, scope, draft(true)),
      saveWorkspaceDraft(userId, scope, { ...draft(false), draftId: "draft-competing" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "draft-concurrent-modification" } });
    const current = await getWorkspace(userId, scope);
    expect(current.draft?.draftRevision).toBe(1);
    expect(current.draft?.patches).toHaveLength(1);
  });

  it("previews a reset that revokes a stored user constraint", async () => {
    const constraints = [{ id: "pin-stats", kind: "pin", status: "explicit", author: "user", scope, anchorId: "dashboard.stats" }];
    await q("INSERT INTO workspace_revisions (id, user_id, surface_id, device_class, revision_number, catalog_version, product_default_version, committed_at, operations, constraints) VALUES ('pinned', ?, 'dashboard', 'desktop', 1, '1.0.0', 'product-1', ?, '[]', ?)", userId, Date.now(), JSON.stringify(constraints));
    const reset: Draft = {
      draftId: "reset-pinned",
      draftRevision: 1,
      baseRevision: "pinned",
      scope,
      status: "ready",
      patches: [{
        patchId: "reset-pinned",
        patchSchemaVersion: 1,
        scope,
        baseRevision: "pinned",
        catalogVersion: "1.0.0",
        author: "user",
        provenance: {},
        intent: { kind: "custom", status: "explicit" },
        operations: [{ type: "pin", operationId: "unpin-stats", anchorId: "dashboard.stats", pinned: false }],
        evidence: [],
        proposedConstraints: [],
        revokedConstraintIds: ["pin-stats"],
      }],
    };
    const saved = await saveWorkspaceDraft(userId, scope, reset);
    expect(saved.draft.status).toBe("ready");
    expect(saved.preview.workspace.placements.find(placement => placement.anchorId === "dashboard.stats")?.pinned).toBe(false);
  });

  it("expires prepare without recreating it", async () => {
    await prepareWorkspace({
      userId,
      scope,
      prepareId: "prepare-expired",
      clientInstanceId: "tab-a",
      draftRevision: 1,
      interactionEpoch: 7,
    });
    const { upsertPrepared } = await import("./store");
    await upsertPrepared(userId, scope, {
      prepareId: "prepare-expired",
      clientInstanceId: "tab-a",
      baseRevision: "default",
      draftRevision: 1,
      interactionEpoch: 7,
      descriptor: (await getWorkspace(userId, scope)).descriptor,
      expiresAt: Date.now() - 1,
    });
    await getWorkspace(userId, scope, "tab-a");
    expect((await import("./store")).loadApplyState).toBeDefined();
    const state = await (await import("./store")).loadApplyState(userId, scope);
    expect(state.prepared).toBeNull();
  });

  it("applies and rolls back current patches from a revision on an older catalog", async () => {
    const oldOperations = [{ operation: { type: "variant", operationId: "old-stats", anchorId: "dashboard.stats", variant: "compact" }, origin: "user", acceptedByUser: true, patchId: "old-patch" }];
    await q("INSERT INTO workspace_revisions (id, user_id, surface_id, device_class, revision_number, catalog_version, product_default_version, committed_at, operations, constraints) VALUES ('old-release', ?, 'dashboard', 'desktop', 1, '0.9.0', 'product-1', ?, ?, '[]')", userId, Date.now(), JSON.stringify(oldOperations));
    const clientInstanceId = "tab-release";
    const apply = async (value: Draft, suffix: string) => {
      const saved = await saveWorkspaceDraft(userId, scope, value);
      expect(saved.draft.status).toBe("ready");
      const prepared = await prepareWorkspace({ userId, scope, prepareId: `prepare-${suffix}`, clientInstanceId, draftRevision: saved.draft.draftRevision, interactionEpoch: 7 });
      const committed = await commitWorkspace({ userId, scope, prepareId: prepared.prepareId, operationId: `operation-${suffix}`, clientInstanceId, draftRevision: saved.draft.draftRevision, interactionEpoch: 7 });
      if (!committed.revision || !committed.leaseToken) throw new Error("Expected a committed revision and activation lease");
      const activated = await activateWorkspace({ userId, scope, clientInstanceId, interactionEpoch: 7, leaseToken: committed.leaseToken });
      await acknowledgeWorkspace({
        userId,
        scope,
        clientInstanceId,
        activationId: activated.activationId,
        effectiveRevision: activated.presentation.pending!.descriptor.effectiveRevision,
        workspaceFingerprint: activated.presentation.pending!.descriptor.workspaceFingerprint,
        presentationEpoch: activated.presentation.pending!.presentationEpoch,
      });
      await completeWorkspaceDraft(userId, scope, saved.draft.draftId);
      return committed.revision;
    };

    const base = draft(false);
    const currentDraft = { ...base, draftId: "after-release", baseRevision: "old-release", patches: base.patches.map(item => ({ ...item, baseRevision: "old-release" })) };
    const first = await apply(currentDraft, "after-release");
    expect(first.catalogVersion).toBe("0.9.0");
    const changed = await getWorkspace(userId, scope, clientInstanceId);
    expect(changed.descriptor.catalogVersion).toBe("1.0.0");
    expect(changed.workspace.placements.find(placement => placement.anchorId === "dashboard.stats")).toMatchObject({ visible: false, variant: "compact" });
    expect(changed.workspace.discoveryAnchorIds.length).toBeGreaterThan(0);
    const placedAnchorId = changed.workspace.discoveryAnchorIds[0];
    await markWorkspaceDiscovery(userId, scope, { seenAnchorIds: [placedAnchorId], placedAnchorIds: [placedAnchorId], dismissedAnchorIds: [] }, clientInstanceId);

    const rollback = await rollbackWorkspace(userId, scope, clientInstanceId, "old-release");
    expect(rollback.draft.patches[0].catalogVersion).toBe("1.0.0");
    expect(rollback.candidate.workspace.placements.find(placement => placement.anchorId === "dashboard.stats")).toMatchObject({ visible: true, variant: "compact" });
    const second = await apply(rollback.draft, "rollback-release");
    expect(second.catalogVersion).toBe("0.9.0");
    const restored = await getWorkspace(userId, scope, clientInstanceId);
    expect(restored.workspace.placements.find(placement => placement.anchorId === "dashboard.stats")).toMatchObject({ visible: true, variant: "compact" });
    expect(restored.workspace.discoveryAnchorIds).not.toContain(placedAnchorId);
    expect(restored.history).toEqual(["default", "old-release", first.revisionId, second.revisionId]);
  });

  it("preserves cumulative discovery decisions and rejects unknown anchors", async () => {
    const { markWorkspaceDiscovery } = await import("./service");
    const { getDiscoveryState } = await import("./discovery");
    await markWorkspaceDiscovery(userId, scope, { seenAnchorIds: ["dashboard.stats"], placedAnchorIds: [], dismissedAnchorIds: ["dashboard.stats"] });
    await markWorkspaceDiscovery(userId, scope, { seenAnchorIds: ["dashboard.activity"], placedAnchorIds: [], dismissedAnchorIds: ["dashboard.activity"] });
    await markWorkspaceDiscovery(userId, scope, { seenAnchorIds: [], placedAnchorIds: ["dashboard.stats"], dismissedAnchorIds: [] });
    expect(await getDiscoveryState(userId, scope)).toEqual({ seenAnchorIds: ["dashboard.activity", "dashboard.stats"], placedAnchorIds: ["dashboard.stats"], dismissedAnchorIds: ["dashboard.activity"], seenAreaIds: [], placedAreaIds: [], dismissedAreaIds: [] });
    await expect(markWorkspaceDiscovery(userId, scope, { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: ["private.query"] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await getDiscoveryState(userId, scope)).dismissedAnchorIds).toEqual(["dashboard.activity"]);
  });

  it("keeps area discovery cumulative, scoped and independent from anchors", async () => {
    const { getDiscoveryState } = await import("./discovery");
    await markWorkspaceDiscovery(userId, scope, { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [], seenAreaIds: ["dashboard.primary"], placedAreaIds: [], dismissedAreaIds: ["dashboard.primary"] });
    await markWorkspaceDiscovery(userId, scope, { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [], seenAreaIds: ["dashboard.secondary"], placedAreaIds: [], dismissedAreaIds: ["dashboard.secondary"] });
    await markWorkspaceDiscovery(userId, scope, { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [], seenAreaIds: [], placedAreaIds: ["dashboard.primary"], dismissedAreaIds: [] });
    expect(await getDiscoveryState(userId, scope)).toEqual({ seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [], seenAreaIds: ["dashboard.primary", "dashboard.secondary"], placedAreaIds: ["dashboard.primary"], dismissedAreaIds: ["dashboard.secondary"] });
    await expect(markWorkspaceDiscovery(userId, scope, { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [], seenAreaIds: ["shell.navigation"], placedAreaIds: [], dismissedAreaIds: [] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("a page load", () => {
  let userId: number;

  beforeEach(async () => {
    await resetDbForTests();
    userId = await user();
  });

  it("moves a tab still showing an older layout to the one saved since, and only once", async () => {
    expect((await getWorkspace(userId, scope, "tab-a")).presentation?.presented?.descriptor.sourceActiveRevision).toBe("default");
    await saveWorkspaceDraft(userId, scope, draft(false));
    await prepareWorkspace({ userId, scope, prepareId: "prepare-b", clientInstanceId: "tab-b", draftRevision: 1, interactionEpoch: 1 });
    const committed = await commitWorkspace({ userId, scope, prepareId: "prepare-b", operationId: "operation-b", clientInstanceId: "tab-b", draftRevision: 1, interactionEpoch: 1 });
    const revisionId = committed.revision!.revisionId;
    // Reading alone never moves it: the tab may be in the middle of something.
    const read = await getWorkspace(userId, scope, "tab-a");
    expect(read.descriptor.sourceActiveRevision).toBe("default");
    expect(read.workspace.placements.find(placement => placement.anchorId === "dashboard.stats")?.visible).toBe(true);

    const opened = await openWorkspacePage(userId, scope, "tab-a");
    expect(opened).toMatchObject({ status: "stable", lastIssuedEpoch: 2, presented: { presentationEpoch: 2 } });
    expect(opened?.presented?.descriptor.sourceActiveRevision).toBe(revisionId);
    const after = await getWorkspace(userId, scope, "tab-a");
    expect(after.descriptor.sourceActiveRevision).toBe(revisionId);
    expect(after.workspace.placements.find(placement => placement.anchorId === "dashboard.stats")?.visible).toBe(false);
    expect(await openWorkspacePage(userId, scope, "tab-a")).toBeNull();
    // The tab that applied keeps its own activation path.
    expect(await openWorkspacePage(userId, scope, "tab-b")).toBeNull();
    expect((await getWorkspace(userId, scope, "tab-b")).presentation?.status).toBe("pendingActivation");
  });

  it("moves a tab whose layout is drawn differently under the same revision, so its events keep counting", async () => {
    const first = await getWorkspace(userId, scope, "tab-a");
    const presented = first.presentation?.presented?.descriptor.effectiveRevision;
    expect(presented).toBeTruthy();
    expect(first.currentEffectiveRevision).toBe(presented);
    // A block seen for the first time: the same (default) revision, drawn as another effective one.
    await markWorkspaceDiscovery(userId, scope, { seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [], seenAreaIds: ["dashboard.primary"], placedAreaIds: [], dismissedAreaIds: [] });
    const read = await getWorkspace(userId, scope, "tab-a");
    expect(read.presentation?.presented?.descriptor.effectiveRevision).toBe(presented);
    expect(read.currentEffectiveRevision).not.toBe(presented);
    // What the page does on load when it is behind: the tab moves, and from then on its events match the map.
    const opened = await openWorkspacePage(userId, scope, "tab-a");
    expect(opened?.presented?.descriptor.effectiveRevision).toBe(read.currentEffectiveRevision);
    const after = await getWorkspace(userId, scope, "tab-a");
    expect(after.currentEffectiveRevision).toBe(after.presentation?.presented?.descriptor.effectiveRevision);
  });
});

describe("workspace apply under concurrency", () => {
  let userId: number;

  beforeEach(async () => {
    await resetDbForTests();
    userId = await user();
    await saveWorkspaceDraft(userId, scope, draft(false));
  });

  const prepareFor = (clientInstanceId: string, prepareId: string) =>
    prepareWorkspace({ userId, scope, prepareId, clientInstanceId, draftRevision: 1, interactionEpoch: 7 });
  const commitFor = (clientInstanceId: string, prepareId: string, operationId = `op-${prepareId}`) =>
    commitWorkspace({ userId, scope, prepareId, operationId, clientInstanceId, draftRevision: 1, interactionEpoch: 7 });
  const rows = async (table: string) => (await q<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n;

  it("reads without writing: the server render and repeated reads leave every table as it was", async () => {
    await getWorkspace(userId, scope, "tab-a");
    const before = await Promise.all(["workspace_presentations", "workspace_descriptors", "workspace_prepared"].map(rows));
    const updated = await q<{ updated_at: number }>("SELECT updated_at FROM workspace_presentations");
    await getWorkspace(userId, scope, "ssr");
    await getWorkspace(userId, scope, "tab-a");
    await getWorkspace(userId, scope, "tab-a");
    expect(await Promise.all(["workspace_presentations", "workspace_descriptors", "workspace_prepared"].map(rows))).toEqual(before);
    expect(await q("SELECT updated_at FROM workspace_presentations")).toEqual(updated);
    expect(before).toEqual([1, 1, 0]);
  });

  it("commits the prepare of the tab that asks, even after another tab prepared", async () => {
    await prepareFor("tab-a", "prepare-a");
    await prepareFor("tab-b", "prepare-b");
    const committed = await commitFor("tab-a", "prepare-a");
    expect(committed.committed).toBe(true);
    expect(committed.revision?.revisionId).toMatch(/^wr_/);
  });

  it("answers both racing retries of one commit with the stored revision and a single lease", async () => {
    await prepareFor("tab-a", "prepare-a");
    const results = await Promise.allSettled([commitFor("tab-a", "prepare-a", "op-same"), commitFor("tab-a", "prepare-a", "op-same")]);
    const done = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const stored = await q<{ id: string }>("SELECT id FROM workspace_revisions");
    expect(stored).toHaveLength(1);
    for (const result of done) expect(result.revision?.revisionId).toBe(stored[0].id);
    expect(done.filter(result => result.leaseToken !== null)).toHaveLength(1);
  });

  it("lets a lease token start one activation only", async () => {
    await prepareFor("tab-a", "prepare-a");
    const { leaseToken } = await commitFor("tab-a", "prepare-a");
    const activate = () => activateWorkspace({ userId, scope, clientInstanceId: "tab-a", interactionEpoch: 7, leaseToken: leaseToken! });
    const results = await Promise.allSettled([activate(), activate()]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });

  it("does not let a read that raced an activation wipe it before the acknowledgement", async () => {
    await prepareFor("tab-a", "prepare-a");
    const { leaseToken } = await commitFor("tab-a", "prepare-a");
    const [activated] = await Promise.all([
      activateWorkspace({ userId, scope, clientInstanceId: "tab-a", interactionEpoch: 7, leaseToken: leaseToken! }),
      getWorkspace(userId, scope, "tab-a"),
      getWorkspace(userId, scope, "tab-b"),
    ]);
    const pending = activated.presentation.pending!;
    const acknowledged = await acknowledgeWorkspace({
      userId,
      scope,
      clientInstanceId: "tab-a",
      activationId: activated.activationId,
      effectiveRevision: pending.descriptor.effectiveRevision,
      workspaceFingerprint: pending.descriptor.workspaceFingerprint,
      presentationEpoch: pending.presentationEpoch,
    });
    expect(acknowledged.status).toBe("stable");
  });
});

describe("the Dashboard layout from before the workspace", () => {
  it("keeps the sections a user hid, on both Dashboard scopes, once", async () => {
    await resetDbForTests();
    const userId = await user();
    const other = await user();
    await q("INSERT INTO settings (user_id, dashboard_layout) VALUES (?, ?), (?, ?)", userId, JSON.stringify([{ id: "tasks", visible: false }, { id: "stats", visible: true }]), other, "");
    const { DATA_MIGRATIONS } = await import("../queries/dataMigrations");
    const { getDb } = await import("../queries/connection");
    const step = DATA_MIGRATIONS.find(item => item.id === "dashboard-layout-to-workspace")!;
    await step.run(getDb());
    await step.run(getDb());
    for (const deviceClass of ["desktop", "mobile"] as const) {
      const result = await getWorkspace(userId, { surfaceId: "dashboard", deviceClass }, "tab-a");
      const visible = (anchorId: string) => result.workspace.placements.find(placement => placement.anchorId === anchorId)?.visible;
      expect(visible("dashboard.tasks")).toBe(false);
      expect(visible("dashboard.stats")).toBe(true);
      expect(result.history).toHaveLength(2);
    }
    expect(await q("SELECT COUNT(*)::int AS n FROM workspace_revisions WHERE user_id = ?", other)).toEqual([{ n: 0 }]);
  });

  it("carries over every section the old Customize could hide", async () => {
    await resetDbForTests();
    const userId = await user();
    const { DASHBOARD_WIDGETS } = await import("../../contracts/dashboard");
    await q("INSERT INTO settings (user_id, dashboard_layout) VALUES (?, ?)", userId, JSON.stringify(DASHBOARD_WIDGETS.map(widget => ({ id: widget.id, visible: false }))));
    const { DATA_MIGRATIONS } = await import("../queries/dataMigrations");
    const { getDb } = await import("../queries/connection");
    await DATA_MIGRATIONS.find(item => item.id === "dashboard-layout-to-workspace")!.run(getDb());
    for (const deviceClass of ["desktop", "mobile"] as const) {
      const result = await getWorkspace(userId, { surfaceId: "dashboard", deviceClass }, "tab-a");
      for (const widget of DASHBOARD_WIDGETS) {
        expect(result.workspace.placements.find(placement => placement.anchorId === `dashboard.${widget.id}`)?.visible, widget.id).toBe(false);
      }
    }
  });
});

describe("undo after a constraint", () => {
  it("revokes the user's constraints made after the target, so the undo resolves", async () => {
    await resetDbForTests();
    const userId = await user();
    const pinned = draft(false);
    const withPin: Draft = {
      ...pinned,
      patches: [{
        ...pinned.patches[0],
        operations: [{ type: "variant", operationId: "op-variant", anchorId: "dashboard.stats", variant: "compact" }],
        proposedConstraints: [{ id: "pin-stats", kind: "pin", status: "explicit", author: "user", scope, anchorId: "dashboard.stats" }],
      }],
    };
    await saveWorkspaceDraft(userId, scope, withPin);
    await prepareWorkspace({ userId, scope, prepareId: "p", clientInstanceId: "tab-a", draftRevision: 1, interactionEpoch: 1 });
    await commitWorkspace({ userId, scope, prepareId: "p", operationId: "o", clientInstanceId: "tab-a", draftRevision: 1, interactionEpoch: 1 });
    const undo = await rollbackWorkspace(userId, scope, "tab-a", "default");
    expect(undo.draft.patches[0].revokedConstraintIds).toEqual(["pin-stats"]);
    expect(undo.candidate.workspace.placements.find(placement => placement.anchorId === "dashboard.stats")).toMatchObject({ variant: "default", pinned: false });
  });

  it("discards a rollback preview that was never saved, leaving the stored draft alone", async () => {
    await resetDbForTests();
    const userId = await user();
    await saveWorkspaceDraft(userId, scope, draft(false));
    await prepareWorkspace({ userId, scope, prepareId: "p", clientInstanceId: "tab-a", draftRevision: 1, interactionEpoch: 1 });
    await commitWorkspace({ userId, scope, prepareId: "p", operationId: "o", clientInstanceId: "tab-a", draftRevision: 1, interactionEpoch: 1 });
    const before = await q("SELECT id, status FROM workspace_drafts WHERE user_id = ?", userId);
    const undo = await rollbackWorkspace(userId, scope, "tab-a", "default");
    await expect(discardWorkspaceDraft(userId, scope, undo.draft.draftId)).resolves.toBeUndefined();
    expect(await q("SELECT id, status FROM workspace_drafts WHERE user_id = ?", userId)).toEqual(before);
    await expect(discardWorkspaceDraft(userId, scope, "draft-other")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("a draft made on an older layout (§21 #16)", () => {
  let userId: number;
  const pinStats = { type: "pin" as const, operationId: "op-b-pin-stats", anchorId: "dashboard.stats", pinned: true };
  const hideActivity = { type: "visibility" as const, operationId: "op-b-hide-activity", anchorId: "dashboard.activity", visible: false };
  /** Tab B's draft, still on the ProductDefault: pins stats (hidden meanwhile by tab A) and hides activity. */
  const staleDraft = (): Draft => {
    const base = draft(false);
    return {
      ...base,
      draftId: "draft-b",
      draftRevision: 2,
      patches: [
        { ...base.patches[0], patchId: "patch-b1", operations: [pinStats] },
        { ...base.patches[0], patchId: "patch-b2", operations: [hideActivity] },
      ],
    };
  };
  const counts = async () => (await q<{ revisions: number; operations: number }>(
    "SELECT (SELECT count(*)::int FROM workspace_revisions WHERE user_id = ?) AS revisions, (SELECT count(*)::int FROM workspace_operations WHERE user_id = ?) AS operations",
    userId, userId,
  ))[0];

  beforeEach(async () => {
    await resetDbForTests();
    userId = await user();
    // Tab A hides stats and applies it.
    await saveWorkspaceDraft(userId, scope, draft(false));
    await prepareWorkspace({ userId, scope, prepareId: "prepare-a", clientInstanceId: "tab-a", draftRevision: 1, interactionEpoch: 1 });
    await commitWorkspace({ userId, scope, prepareId: "prepare-a", operationId: "operation-a", clientInstanceId: "tab-a", draftRevision: 1, interactionEpoch: 1 });
    await completeWorkspaceDraft(userId, scope, "draft-1", 1);
  });

  it("is refused as changed, saying how many of its changes can be kept", async () => {
    await expect(saveWorkspaceDraft(userId, scope, staleDraft())).rejects.toMatchObject({ code: "CONFLICT", cause: { info: { keepable: 1 } } });
  });

  it("re-proposes only its changes disjoint from the commit, as an unsaved preview on the current revision", async () => {
    const before = await getWorkspace(userId, scope, "tab-b");
    const stored = await counts();
    const result = await reproposeWorkspaceDraft(userId, scope, staleDraft());
    expect(await counts()).toEqual(stored);
    const after = await getWorkspace(userId, scope, "tab-b");
    expect(after.history).toEqual(before.history);
    expect(after.committedRevision).toBe(before.committedRevision);
    expect(result.draft).toMatchObject({ baseRevision: before.committedRevision, status: "ready" });
    expect(result.draft?.draftRevision).toBeGreaterThan(2);
    expect(result.draft?.patches.flatMap(patch => patch.operations.map(item => item.operationId))).toEqual(["op-b-hide-activity"]);
    expect(result.draft?.patches.every(patch => patch.baseRevision === before.committedRevision)).toBe(true);
    expect(result.dropped).toEqual([{ operationId: "op-b-pin-stats", anchorId: "dashboard.stats", reason: "overlap" }]);
    const placement = (anchorId: string) => result.preview?.workspace.placements.find(item => item.anchorId === anchorId);
    expect(placement("dashboard.activity")).toMatchObject({ visible: false });
    expect(placement("dashboard.stats")).toMatchObject({ visible: false, pinned: false });
    // The live layout is still tab A's: the proposal is only a draft until the user applies it.
    expect(after.workspace.placements.find(item => item.anchorId === "dashboard.activity")).toMatchObject({ visible: true });
    expect(after.draft?.draftId).toBe(result.draft?.draftId);
  });

  it("writes nothing when none of its changes can be kept", async () => {
    const onlyOverlap: Draft = { ...staleDraft(), patches: [staleDraft().patches[0]] };
    const result = await reproposeWorkspaceDraft(userId, scope, onlyOverlap);
    expect(result.draft).toBeNull();
    expect(result.dropped).toHaveLength(1);
    expect((await getWorkspace(userId, scope)).draft).toBeNull();
  });

  it("never replaces another tab's open draft", async () => {
    const committed = (await getWorkspace(userId, scope)).committedRevision ?? "default";
    const base = draft(true);
    await saveWorkspaceDraft(userId, scope, { ...base, draftId: "draft-c", baseRevision: committed, patches: [{ ...base.patches[0], baseRevision: committed }] });
    await expect(reproposeWorkspaceDraft(userId, scope, staleDraft())).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getWorkspace(userId, scope)).draft?.draftId).toBe("draft-c");
  });
});
