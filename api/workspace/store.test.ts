import { beforeEach, describe, expect, it } from "vitest";
import { q, resetDbForTests } from "../queries/connection";
import { createOpaqueEntry } from "./crypto";
import type { ActiveRevision, Draft, PresentationDescriptor, Scope } from "@contracts/workspace/model";
import type { PresentationState, PreparedRevision } from "@contracts/workspace/applyMachine";
import {
  commitRevision,
  latestDraft,
  latestRevision,
  loadApplyState,
  operationResponse,
  saveDescriptor,
  upsertDraft,
  upsertPrepared,
  writePresentation,
} from "./store";

const scope: Scope = { surfaceId: "dashboard", deviceClass: "desktop" };
const NOW = 1_800_000_000_000;

function descriptor(revision: string): PresentationDescriptor {
  return {
    effectiveRevision: `eff-${revision}`,
    sourceActiveRevision: revision,
    workspaceFingerprint: `fp-${revision}`,
    productDefaultVersion: "product-1",
    catalogVersion: "catalog-1",
    resolverVersion: 1,
    constraintsFingerprint: `constraints-${revision}`,
    feedbackFingerprint: "feedback-1",
    discoveryFingerprint: "discovery-1",
    rendererBindingsFingerprint: "renderers-1",
  };
}

const rev0 = descriptor("rev-0");
const rev1 = descriptor("rev-1");

function revision(id = "rev-1"): ActiveRevision {
  return {
    revisionId: id,
    scope,
    catalogVersion: "catalog-1",
    productDefaultVersion: "product-1",
    committedAt: NOW,
    operations: [],
    constraints: [],
    opaque: [],
  };
}

function presentation(clientInstanceId = "tab-a"): PresentationState {
  return {
    clientInstanceId,
    status: "pendingActivation",
    lastIssuedEpoch: 2,
    presented: { descriptor: rev0, presentationEpoch: 1 },
    pending: {
      leaseId: "lease-1",
      leaseTokenHash: "a".repeat(64),
      leaseExpiresAt: NOW + 15_000,
      descriptor: rev1,
      draftRevision: 1,
      interactionEpoch: 7,
      presentationEpoch: 2,
    },
  };
}

function prepared(prepareId = "prepare-1"): PreparedRevision {
  return {
    prepareId,
    clientInstanceId: "tab-a",
    baseRevision: "default",
    draftRevision: 1,
    interactionEpoch: 7,
    descriptor: rev1,
    expiresAt: NOW + 60_000,
  };
}

async function user(displayName: string): Promise<number> {
  const rows = await q<{ id: number }>("INSERT INTO users(display_name, created_at) VALUES (?, ?) RETURNING id", displayName, NOW);
  return rows[0].id;
}

describe("workspace persistence", () => {
  let first: number;
  let second: number;

  beforeEach(async () => {
    await resetDbForTests();
    first = await user("First");
    second = await user("Second");
  });

  it("commits once, deletes prepare and reconstructs state with no cross-user leakage", async () => {
    await saveDescriptor(first, scope, rev0);
    await upsertPrepared(first, scope, prepared());
    const input = {
      userId: first,
      scope,
      revision: revision(),
      descriptor: rev1,
      presentation: presentation(),
      expectedPresentation: null,
      operationId: "operation-1",
      prepareId: "prepare-1",
      baseRevision: "default",
      draftId: null,
      draftRevision: 1,
    };
    expect(await commitRevision(input)).toBe(true);
    expect(await commitRevision(input)).toBe(false);
    expect(await operationResponse(first, scope, "operation-1")).toEqual({ revisionId: "rev-1" });
    expect((await latestRevision(first, scope))?.revisionId).toBe("rev-1");
    expect((await latestRevision(second, scope))).toBeNull();
    const state = await loadApplyState(first, scope);
    expect(state.committedRevision).toBe("rev-1");
    expect(state.prepared).toBeNull();
    expect(state.history).toEqual(["default", "rev-1"]);
    expect(state.operationIds).toEqual(["operation-1"]);
    expect(state.presentations["tab-a"]?.pending?.descriptor).toEqual(rev1);
    expect(state.presentations["tab-a"]?.presented?.descriptor).toEqual(rev0);
    expect(state.descriptors["eff-rev-1"]).toEqual(rev1);
    expect(await q("SELECT COUNT(*) AS n FROM workspace_prepared")).toEqual([{ n: 0 }]);
  });

  it("allows identical fingerprints and revision ids on independent user boundaries", async () => {
    await upsertPrepared(first, scope, prepared("prepare-first"));
    await upsertPrepared(second, scope, { ...prepared("prepare-second"), clientInstanceId: "tab-b" });
    const base = {
      scope,
      revision: revision(),
      descriptor: rev1,
      expectedPresentation: null,
      operationId: "operation-shared",
      baseRevision: "default",
      draftId: null,
      draftRevision: 1,
    };
    expect(await commitRevision({ ...base, userId: first, presentation: presentation(), prepareId: "prepare-first" })).toBe(true);
    expect(await commitRevision({ ...base, userId: second, presentation: presentation("tab-b"), prepareId: "prepare-second" })).toBe(true);
    expect((await latestRevision(first, scope))?.revisionId).toBe("rev-1");
    expect((await latestRevision(second, scope))?.revisionId).toBe("rev-1");
    expect((await loadApplyState(first, scope)).descriptors["eff-rev-1"]).toEqual(rev1);
    expect((await loadApplyState(second, scope)).descriptors["eff-rev-1"]).toEqual(rev1);
  });

  it("round-trips drafts and validates originalText out of persisted patches", async () => {
    const draft: Draft = {
      draftId: "draft-1",
      draftRevision: 1,
      baseRevision: "rev-0",
      scope,
      status: "ready",
      patches: [{
        patchId: "patch-1",
        patchSchemaVersion: 1,
        scope,
        baseRevision: "rev-0",
        catalogVersion: "catalog-1",
        author: "user",
        provenance: {},
        intent: { kind: "prioritize", status: "explicit", anchorId: "stats" },
        operations: [],
        evidence: [],
        proposedConstraints: [],
      }],
    };
    await upsertDraft(first, draft);
    expect((await latestDraft(first, scope))?.patches[0].intent).toEqual(draft.patches[0].intent);
    expect((await latestDraft(second, scope))).toBeNull();
    const withText = {
      ...draft,
      patches: [{ ...draft.patches[0], originalText: "do not persist" }],
    } as unknown as Draft;
    await expect(upsertDraft(first, withText)).rejects.toThrow();
  });

  it("persists and reloads presentation state and prepare expiry as real timestamps", async () => {
    await writePresentation(first, scope, null, presentation());
    await upsertPrepared(first, scope, prepared());
    const state = await loadApplyState(first, scope, "prepare-1");
    expect(state.presentations["tab-a"]?.lastIssuedEpoch).toBe(2);
    expect(state.presentations["tab-a"]?.pending?.leaseTokenHash).toBe("a".repeat(64));
    expect(state.prepared?.expiresAt).toBe(NOW + 60_000);
    expect(state.prepared?.descriptor).toEqual(rev1);
  });

  it("writes a presentation only over the row it was computed from", async () => {
    // Two transitions read the same row: the second must not undo the first (an activation, an ack).
    await writePresentation(first, scope, null, presentation());
    const read = (await loadApplyState(first, scope)).presentations["tab-a"];
    await writePresentation(first, scope, read, { ...read, pending: { ...read.pending!, activationId: "activation-1" } });
    await expect(writePresentation(first, scope, read, { ...read, status: "stable", lastIssuedEpoch: 1, presented: { descriptor: rev0, presentationEpoch: 1 }, pending: undefined }))
      .rejects.toMatchObject({ code: "presentation-concurrent-modification" });
    await expect(writePresentation(first, scope, null, presentation())).rejects.toMatchObject({ code: "presentation-concurrent-modification" });
    const state = await loadApplyState(first, scope);
    expect(state.presentations["tab-a"]?.lastIssuedEpoch).toBe(2);
    expect(state.presentations["tab-a"]?.pending?.activationId).toBe("activation-1");
  });

  it("loads the prepared revision of the tab that asks, not the newest one", async () => {
    await upsertPrepared(first, scope, prepared("prepare-a"));
    await upsertPrepared(first, scope, { ...prepared("prepare-b"), clientInstanceId: "tab-b" });
    expect((await loadApplyState(first, scope, "prepare-a")).prepared?.prepareId).toBe("prepare-a");
    expect((await loadApplyState(first, scope)).prepared).toBeNull();
  });

  it("rejects a stale base without writing a revision or an operation", async () => {
    await upsertPrepared(first, scope, prepared());
    await expect(commitRevision({ userId: first, scope, revision: revision(), descriptor: rev1, presentation: presentation(), expectedPresentation: null, operationId: "stale-operation", prepareId: "prepare-1", baseRevision: "rev-0", draftId: null, draftRevision: 1 })).rejects.toMatchObject({ code: "stale-base" });
    expect(await latestRevision(first, scope)).toBeNull();
    expect(await operationResponse(first, scope, "stale-operation")).toBeNull();
  });

  it("keeps a draft per scope: the same id elsewhere is another draft, not this one overwritten", async () => {
    const mobile: Scope = { surfaceId: "mobile-tabs", deviceClass: "mobile" };
    const draftIn = (target: Scope, anchorId: string): Draft => ({ draftId: "same-id", draftRevision: 1, baseRevision: "default", scope: target, status: "ready", patches: [{ patchId: `p-${anchorId}`, patchSchemaVersion: 1, scope: target, baseRevision: "default", catalogVersion: "catalog-1", author: "user", provenance: {}, intent: { kind: "custom", status: "explicit" }, operations: [{ type: "variant", operationId: "o", anchorId, variant: "compact" }], evidence: [], proposedConstraints: [] }] });
    await upsertDraft(first, draftIn(scope, "dashboard.stats"));
    await upsertDraft(first, draftIn(mobile, "mobile.home"));
    expect((await latestDraft(first, scope))?.patches[0].patchId).toBe("p-dashboard.stats");
    expect((await latestDraft(first, mobile))?.patches[0].patchId).toBe("p-mobile.home");
  });

  it("stores unknown future content with the revision, byte for byte", async () => {
    const opaque = [createOpaqueEntry("future.layout", 2, new TextEncoder().encode('{"x":[1,2]}'))];
    await upsertPrepared(first, scope, prepared());
    expect(await commitRevision({ userId: first, scope, revision: { ...revision(), opaque }, descriptor: rev1, presentation: presentation(), expectedPresentation: null, operationId: "op-opaque", prepareId: "prepare-1", baseRevision: "default", draftId: null, draftRevision: 1 })).toBe(true);
    expect((await latestRevision(first, scope))?.opaque).toEqual(opaque);
  });

  it("refuses oversized input and opaque entries whose digest lies", async () => {
    const big = { ...revision(), operations: [{ operation: { type: "reorder" as const, operationId: "o", areaId: "a", anchorIds: Array.from({ length: 65 }, (_, i) => `a${i}`) }, origin: "user" as const, acceptedByUser: true }] };
    await upsertPrepared(first, scope, prepared());
    await expect(commitRevision({ userId: first, scope, revision: big, descriptor: rev1, presentation: presentation(), expectedPresentation: null, operationId: "op-big", prepareId: "prepare-1", baseRevision: "default", draftId: null, draftRevision: 1 })).rejects.toThrow();
    const [entry] = [createOpaqueEntry("future.layout", 2, new TextEncoder().encode("{}"))];
    const lying = [{ ...entry, sha256: "0".repeat(64) }];
    await expect(commitRevision({ userId: first, scope, revision: { ...revision(), opaque: lying }, descriptor: rev1, presentation: presentation(), expectedPresentation: null, operationId: "op-lie", prepareId: "prepare-1", baseRevision: "default", draftId: null, draftRevision: 1 })).rejects.toThrow(/digest/);
    expect(await latestRevision(first, scope)).toBeNull();
  });
});

