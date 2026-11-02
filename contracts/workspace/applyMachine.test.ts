import { describe, expect, it } from "vitest";
import type { PresentationDescriptor, Scope } from "./model";
import {
  acknowledgeActivation,
  attributeEvent,
  beginActivation,
  commit,
  deferActivation,
  expire,
  initialApplyState,
  pageLoadPresentation,
  prepare,
  reconcilePresentation,
  renewActivationLease,
  rollbackPreview,
  ssrDecision,
  withPresented,
  WorkspaceApplyError,
  type ApplyState,
} from "./applyMachine";
import { APPLY_POLICY_V1 } from "./versions";

const scope: Scope = { surfaceId: "dashboard", deviceClass: "desktop" };
const NOW = 1_000_000;

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
const rev2 = descriptor("rev-2");

function setup(): ApplyState {
  return withPresented(initialApplyState(scope, rev0), "tab-a", rev0, 1);
}

function prepareNext(state: ApplyState, next = rev1): ApplyState {
  return prepare(state, {
    prepareId: "prepare-1",
    clientInstanceId: "tab-a",
    baseRevision: state.committedRevision!,
    draftRevision: 4,
    interactionEpoch: 7,
    descriptor: next,
    now: NOW,
  });
}

function commitNext(state: ApplyState): ApplyState {
  return commit(state, {
    prepareId: "prepare-1",
    operationId: "operation-1",
    clientInstanceId: "tab-a",
    draftRevision: 4,
    interactionEpoch: 7,
    leaseId: "lease-1",
    leaseTokenHash: "lease-hash",
    now: NOW,
  });
}

function beginNext(state: ApplyState): ApplyState {
  return beginActivation(state, {
    clientInstanceId: "tab-a",
    interactionEpoch: 7,
    activationId: "activation-1",
    leaseTokenHash: "lease-hash",
    now: NOW,
  });
}

function ackNext(state: ApplyState): ApplyState {
  return acknowledgeActivation(state, {
    clientInstanceId: "tab-a",
    activationId: "activation-1",
    effectiveRevision: rev1.effectiveRevision,
    workspaceFingerprint: rev1.workspaceFingerprint,
    presentationEpoch: 2,
  });
}

describe("prepare and commit", () => {
  it("prepare is validated and idempotent without changing committed or presented revisions", () => {
    const initial = setup();
    const prepared = prepareNext(initial);
    expect(prepared.committedRevision).toBe("rev-0");
    expect(prepared.prepared?.descriptor).toEqual(rev1);
    expect(prepared.presentations["tab-a"]?.presented?.descriptor).toEqual(rev0);
    expect(prepareNext(prepared)).toBe(prepared);
    expect(prepareNext(initial).history).toEqual(["rev-0"]);
  });

  it("rejects a task/interaction change between prepare and commit", () => {
    const prepared = prepareNext(setup());
    expect(() => commit(prepared, {
      prepareId: "prepare-1",
      operationId: "operation-1",
      clientInstanceId: "tab-a",
      draftRevision: 4,
      interactionEpoch: 8,
      leaseId: "lease-1",
      leaseTokenHash: "lease-hash",
      now: NOW,
    })).toThrowError(new WorkspaceApplyError("prepare-precondition-changed"));
    expect(prepared.committedRevision).toBe("rev-0");
    expect(prepared.presentations["tab-a"]?.presented?.descriptor).toEqual(rev0);
  });

  it("rejects stale base and expired prepare without side effects", () => {
    expect(() => prepare(setup(), {
      prepareId: "prepare-stale",
      clientInstanceId: "tab-a",
      baseRevision: "missing",
      draftRevision: 4,
      interactionEpoch: 7,
      descriptor: rev1,
      now: NOW,
    })).toThrowError(new WorkspaceApplyError("stale-base-revision"));
    const prepared = prepareNext(setup());
    expect(() => commit(prepared, {
      prepareId: "prepare-1",
      operationId: "operation-1",
      clientInstanceId: "tab-a",
      draftRevision: 4,
      interactionEpoch: 7,
      leaseId: "lease-1",
      leaseTokenHash: "lease-hash",
      now: NOW + APPLY_POLICY_V1.preparedTtlMs,
    })).toThrowError(new WorkspaceApplyError("prepare-expired"));
  });

  it("commits atomically, creates a bound lease and keeps other clients on their presented revision", () => {
    const withOther = withPresented(setup(), "tab-b", rev0, 1);
    const committed = commitNext(prepareNext(withOther));
    expect(committed.committedRevision).toBe("rev-1");
    expect(committed.history).toEqual(["rev-0", "rev-1"]);
    expect(committed.presentations["tab-a"]).toMatchObject({ status: "pendingActivation" });
    expect(committed.presentations["tab-a"]?.presented?.descriptor).toEqual(rev0);
    expect(committed.presentations["tab-a"]?.pending).toMatchObject({
      leaseTokenHash: "lease-hash",
      draftRevision: 4,
      interactionEpoch: 7,
      presentationEpoch: 2,
    });
    expect(committed.presentations["tab-b"]?.status).toBe("stable");
    expect(commitNext(committed)).toBe(committed);
  });
});

describe("activation and event attribution", () => {
  it("keeps old-rendering events on the old effective revision after commit", () => {
    const committed = commitNext(prepareNext(setup()));
    expect(attributeEvent(committed, {
      clientInstanceId: "tab-a",
      effectiveRevision: rev0.effectiveRevision,
      workspaceFingerprint: rev0.workspaceFingerprint,
      presentationEpoch: 1,
    })).toEqual({ kind: "attributed", descriptor: rev0, presentationStatus: "pendingActivation" });
    expect(attributeEvent(committed, {
      clientInstanceId: "tab-a",
      effectiveRevision: rev1.effectiveRevision,
      workspaceFingerprint: rev1.workspaceFingerprint,
      presentationEpoch: 1,
    })).toEqual({ kind: "isolated", reason: "presentation-proof-mismatch" });
  });

  it("defers activation if a task starts after commit and never rolls back the committed revision", () => {
    const committed = commitNext(prepareNext(setup()));
    expect(() => beginActivation(committed, {
      clientInstanceId: "tab-a",
      interactionEpoch: 8,
      activationId: "activation-1",
      leaseTokenHash: "lease-hash",
      now: NOW,
    })).toThrowError(new WorkspaceApplyError("interaction-epoch-changed"));
    const deferred = deferActivation(committed, "tab-a", 7);
    expect(deferred.committedRevision).toBe("rev-1");
    expect(deferred.presentations["tab-a"]?.status).toBe("stable");
    expect(deferred.presentations["tab-a"]?.presented?.descriptor).toEqual(rev0);
    expect(attributeEvent(deferred, {
      clientInstanceId: "tab-a",
      effectiveRevision: rev0.effectiveRevision,
      workspaceFingerprint: rev0.workspaceFingerprint,
      presentationEpoch: 1,
    })).toMatchObject({ kind: "attributed", descriptor: rev0 });
  });

  it("acknowledges activation idempotently and attributes post-presentation events to the new workspace", () => {
    const active = beginNext(commitNext(prepareNext(setup())));
    const acknowledged = ackNext(active);
    expect(acknowledged.presentations["tab-a"]).toMatchObject({ status: "stable" });
    expect(acknowledged.presentations["tab-a"]?.presented).toEqual({ descriptor: rev1, presentationEpoch: 2 });
    expect(ackNext(acknowledged)).toBe(acknowledged);
    expect(attributeEvent(acknowledged, {
      clientInstanceId: "tab-a",
      effectiveRevision: rev1.effectiveRevision,
      workspaceFingerprint: rev1.workspaceFingerprint,
      presentationEpoch: 2,
      activationId: "activation-1",
    })).toEqual({ kind: "attributed", descriptor: rev1, presentationStatus: "stable" });
  });

  it("attributes events from the new view even before acknowledgement without treating them as ack", () => {
    const active = beginNext(commitNext(prepareNext(setup())));
    expect(attributeEvent(active, {
      clientInstanceId: "tab-a",
      effectiveRevision: rev1.effectiveRevision,
      workspaceFingerprint: rev1.workspaceFingerprint,
      presentationEpoch: 2,
      activationId: "activation-1",
    })).toEqual({ kind: "attributed", descriptor: rev1, presentationStatus: "pendingActivation" });
    expect(active.presentations["tab-a"]?.status).toBe("pendingActivation");
  });

  it("isolates missing, forged or cross-client presentation proofs instead of using committed revision", () => {
    const committed = commitNext(prepareNext(setup()));
    expect(attributeEvent(committed, {
      clientInstanceId: "unknown",
      effectiveRevision: rev0.effectiveRevision,
      workspaceFingerprint: rev0.workspaceFingerprint,
      presentationEpoch: 1,
    })).toEqual({ kind: "isolated", reason: "unknown-client" });
    expect(attributeEvent(committed, {
      clientInstanceId: "tab-a",
      effectiveRevision: rev1.effectiveRevision,
      workspaceFingerprint: rev1.workspaceFingerprint,
      presentationEpoch: 2,
      activationId: "forged",
    })).toEqual({ kind: "isolated", reason: "presentation-proof-mismatch" });
    expect(() => beginActivation(committed, {
      clientInstanceId: "tab-b",
      interactionEpoch: 7,
      activationId: "activation-stolen",
      leaseTokenHash: "lease-hash",
      now: NOW,
    })).toThrowError(new WorkspaceApplyError("activation-lease-not-found"));
  });
});

describe("timeouts, reconnection and independent tabs", () => {
  it("expires prepare after disconnection without changing any revision", () => {
    const prepared = prepareNext(setup());
    const expired = expire(prepared, NOW + APPLY_POLICY_V1.preparedTtlMs);
    expect(expired.prepared).toBeNull();
    expect(expired.committedRevision).toBe("rev-0");
    expect(expired.presentations["tab-a"]?.presented?.descriptor).toEqual(rev0);
  });

  it("expires an unused lease without rollback and allows a fresh lease", () => {
    const committed = commitNext(prepareNext(setup()));
    const expired = expire(committed, NOW + APPLY_POLICY_V1.activationLeaseTtlMs);
    expect(expired.committedRevision).toBe("rev-1");
    expect(expired.presentations["tab-a"]?.status).toBe("stable");
    expect(expired.presentations["tab-a"]?.presented?.descriptor).toEqual(rev0);
    const renewed = renewActivationLease(expired, {
      clientInstanceId: "tab-a",
      draftRevision: 4,
      interactionEpoch: 7,
      leaseId: "lease-2",
      leaseTokenHash: "lease-hash-2",
      now: NOW + APPLY_POLICY_V1.activationLeaseTtlMs,
    });
    expect(renewed.presentations["tab-a"]?.pending).toMatchObject({ leaseId: "lease-2", presentationEpoch: 3 });
    expect(renewed.history).toEqual(["rev-0", "rev-1"]);
  });

  it("moves to activationUncertain, then unknown, without assuming the presented view", () => {
    const active = beginNext(commitNext(prepareNext(setup())));
    const uncertain = expire(active, NOW + APPLY_POLICY_V1.pendingActivationTtlMs);
    expect(uncertain.presentations["tab-a"]?.status).toBe("activationUncertain");
    expect(attributeEvent(uncertain, {
      clientInstanceId: "tab-a",
      effectiveRevision: rev1.effectiveRevision,
      workspaceFingerprint: rev1.workspaceFingerprint,
      presentationEpoch: 2,
      activationId: "activation-1",
    })).toEqual({ kind: "attributed", descriptor: rev1, presentationStatus: "activationUncertain" });
    const unknown = expire(uncertain, NOW + APPLY_POLICY_V1.pendingActivationTtlMs + APPLY_POLICY_V1.activationUncertainRetentionMs);
    expect(unknown.presentations["tab-a"]?.status).toBe("unknown");
    expect(unknown.committedRevision).toBe("rev-1");
    expect(ssrDecision(unknown, "tab-a")).toEqual({ kind: "reconcile", reason: "unknown" });
  });

  it("requires reconciliation after activation has started instead of replacing its proof", () => {
    const active = beginNext(commitNext(prepareNext(setup())));
    expect(() => deferActivation(active, "tab-a", 7)).toThrowError(new WorkspaceApplyError("activation-reconciliation-required"));
    const uncertain = expire(active, NOW + APPLY_POLICY_V1.pendingActivationTtlMs);
    expect(() => renewActivationLease(uncertain, {
      clientInstanceId: "tab-a",
      draftRevision: 4,
      interactionEpoch: 7,
      leaseId: "lease-replacement",
      leaseTokenHash: "replacement-hash",
      now: NOW + APPLY_POLICY_V1.pendingActivationTtlMs,
    })).toThrowError(new WorkspaceApplyError("activation-reconciliation-required"));
    const secondPrepared = prepare(uncertain, {
      prepareId: "prepare-2",
      clientInstanceId: "tab-a",
      baseRevision: "rev-1",
      draftRevision: 5,
      interactionEpoch: 8,
      descriptor: rev2,
      now: NOW + 1,
    });
    expect(() => commit(secondPrepared, {
      prepareId: "prepare-2",
      operationId: "operation-2",
      clientInstanceId: "tab-a",
      draftRevision: 5,
      interactionEpoch: 8,
      leaseId: "lease-2",
      leaseTokenHash: "lease-hash-2",
      now: NOW + 2,
    })).toThrowError(new WorkspaceApplyError("activation-already-pending"));
  });

  it("accepts a late acknowledgement to reconcile and rejects an older epoch", () => {
    const active = beginNext(commitNext(prepareNext(setup())));
    const uncertain = expire(active, NOW + APPLY_POLICY_V1.pendingActivationTtlMs);
    const acknowledged = ackNext(uncertain);
    expect(acknowledged.presentations["tab-a"]?.status).toBe("stable");
    expect(ackNext(acknowledged)).toBe(acknowledged);
    expect(() => acknowledgeActivation(acknowledged, {
      clientInstanceId: "tab-a",
      activationId: "activation-older",
      effectiveRevision: rev0.effectiveRevision,
      workspaceFingerprint: rev0.workspaceFingerprint,
      presentationEpoch: 1,
    })).toThrowError(new WorkspaceApplyError("activation-not-found"));
  });

  it("reconciles only the exact presented descriptor after an uncertain activation", () => {
    const active = beginNext(commitNext(prepareNext(setup())));
    const uncertain = expire(active, NOW + APPLY_POLICY_V1.pendingActivationTtlMs);
    expect(() => reconcilePresentation(uncertain, {
      clientInstanceId: "tab-a",
      effectiveRevision: rev1.effectiveRevision,
      workspaceFingerprint: "wrong",
      presentationEpoch: 2,
    })).toThrowError(new WorkspaceApplyError("presentation-proof-mismatch"));
    const reconciled = reconcilePresentation(uncertain, {
      clientInstanceId: "tab-a",
      effectiveRevision: rev1.effectiveRevision,
      workspaceFingerprint: rev1.workspaceFingerprint,
      presentationEpoch: 2,
    });
    expect(reconciled.presentations["tab-a"]?.status).toBe("stable");
  });

  it("refuses to activate a lease that a newer commit from another tab superseded", () => {
    // Tab B renews a lease on rev-1, then tab A commits rev-2: B must not present rev-1 as new.
    const committed = commitNext(prepareNext(setup()));
    const leased = renewActivationLease(withPresented(committed, "tab-b", rev0, 1), {
      clientInstanceId: "tab-b",
      draftRevision: 4,
      interactionEpoch: 3,
      leaseId: "lease-b",
      leaseTokenHash: "hash-b",
      now: NOW,
    });
    const newer = prepare(ackNext(beginNext(leased)), {
      prepareId: "prepare-2",
      clientInstanceId: "tab-a",
      baseRevision: "rev-1",
      draftRevision: 5,
      interactionEpoch: 8,
      descriptor: rev2,
      now: NOW + 1,
    });
    const superseded = commit(newer, {
      prepareId: "prepare-2",
      operationId: "operation-2",
      clientInstanceId: "tab-a",
      draftRevision: 5,
      interactionEpoch: 8,
      leaseId: "lease-2",
      leaseTokenHash: "lease-hash-2",
      now: NOW + 2,
    });
    expect(() => beginActivation(superseded, {
      clientInstanceId: "tab-b",
      interactionEpoch: 3,
      activationId: "activation-b",
      leaseTokenHash: "hash-b",
      now: NOW + 3,
    })).toThrowError(new WorkspaceApplyError("activation-superseded"));
  });

  it("keeps the identity of whatever did not expire, so nothing unchanged is written back", () => {
    const state = commitNext(prepareNext(withPresented(setup(), "tab-b", rev0, 1)));
    const later = expire(state, NOW + 1);
    expect(later).toBe(state);
    const leaseGone = expire(state, NOW + APPLY_POLICY_V1.activationLeaseTtlMs);
    expect(leaseGone.presentations["tab-b"]).toBe(state.presentations["tab-b"]);
    expect(leaseGone.presentations["tab-a"]).not.toBe(state.presentations["tab-a"]);
  });

  it("gives a new tab an independent descriptor and lease while the original tab stays pending", () => {
    const committed = commitNext(prepareNext(setup()));
    expect(ssrDecision(committed, "tab-a")).toEqual({ kind: "reconcile", reason: "pendingActivation" });
    expect(ssrDecision(committed, "tab-b")).toEqual({ kind: "activate", descriptor: rev1 });
    const both = withPresented(committed, "tab-b", rev1, 1);
    expect(attributeEvent(both, {
      clientInstanceId: "tab-a",
      effectiveRevision: rev0.effectiveRevision,
      workspaceFingerprint: rev0.workspaceFingerprint,
      presentationEpoch: 1,
    })).toMatchObject({ kind: "attributed", descriptor: rev0 });
    expect(attributeEvent(both, {
      clientInstanceId: "tab-b",
      effectiveRevision: rev1.effectiveRevision,
      workspaceFingerprint: rev1.workspaceFingerprint,
      presentationEpoch: 1,
    })).toMatchObject({ kind: "attributed", descriptor: rev1 });
  });
});

describe("page load", () => {
  it("moves a stable tab that fell behind to the committed layout, with a new epoch", () => {
    const behind = withPresented(initialApplyState(scope, rev1), "tab-a", rev0, 1);
    expect(pageLoadPresentation(behind, "tab-a", rev1)).toEqual({
      clientInstanceId: "tab-a",
      status: "stable",
      lastIssuedEpoch: 2,
      presented: { descriptor: rev1, presentationEpoch: 2 },
    });
  });

  it("leaves a current, unknown, pending or uncertain tab to the existing paths", () => {
    expect(pageLoadPresentation(setup(), "tab-a", rev0)).toBeNull();
    expect(pageLoadPresentation(setup(), "tab-b", rev1)).toBeNull();
    const pending = commitNext(prepareNext(setup()));
    expect(pageLoadPresentation(pending, "tab-a", rev1)).toBeNull();
    const uncertain = expire(beginNext(pending), NOW + APPLY_POLICY_V1.pendingActivationTtlMs);
    expect(pageLoadPresentation(uncertain, "tab-a", rev1)).toBeNull();
  });
});

describe("SSR and rollback", () => {
  it("uses a stable presented descriptor and never guesses during pending or uncertain states", () => {
    const stable = setup();
    expect(ssrDecision(stable, "tab-a")).toEqual({ kind: "present", descriptor: rev0 });
    const pending = commitNext(prepareNext(stable));
    expect(ssrDecision(pending, "tab-a")).toEqual({ kind: "reconcile", reason: "pendingActivation" });
    const uncertain = expire(beginNext(pending), NOW + APPLY_POLICY_V1.pendingActivationTtlMs);
    expect(ssrDecision(uncertain, "tab-a")).toEqual({ kind: "reconcile", reason: "activationUncertain" });
  });

  it("rollback from a non-reconciled tab is a new prepare, never history rewriting", () => {
    const committed = commitNext(prepareNext(setup()));
    const preview = rollbackPreview(committed, "tab-a", "rev-0");
    expect(preview).toEqual({ targetRevision: "rev-0", presentedRevision: "rev-0", requiresPrepare: true });
    expect(committed.history).toEqual(["rev-0", "rev-1"]);
    expect(() => rollbackPreview(committed, "tab-a", "missing")).toThrowError(new WorkspaceApplyError("rollback-target-not-found"));
  });

  it("does not commit a revision already present or reuse a lease after expiry", () => {
    expect(() => prepare(setup(), {
      prepareId: "prepare-duplicate",
      clientInstanceId: "tab-a",
      baseRevision: "rev-0",
      draftRevision: 4,
      interactionEpoch: 7,
      descriptor: rev0,
      now: NOW,
    })).toThrowError(new WorkspaceApplyError("revision-already-committed"));
    const committed = commitNext(prepareNext(setup()));
    expect(() => beginActivation(committed, {
      clientInstanceId: "tab-a",
      interactionEpoch: 7,
      activationId: "activation-late",
      leaseTokenHash: "lease-hash",
      now: NOW + APPLY_POLICY_V1.activationLeaseTtlMs,
    })).toThrowError(new WorkspaceApplyError("activation-lease-expired"));
  });

  it("keeps multiple commits and their effective descriptors independent", () => {
    const first = ackNext(beginNext(commitNext(prepareNext(setup()))));
    const secondPrepared = prepare(first, {
      prepareId: "prepare-2",
      clientInstanceId: "tab-a",
      baseRevision: "rev-1",
      draftRevision: 5,
      interactionEpoch: 8,
      descriptor: rev2,
      now: NOW + 1,
    });
    const second = commit(secondPrepared, {
      prepareId: "prepare-2",
      operationId: "operation-2",
      clientInstanceId: "tab-a",
      draftRevision: 5,
      interactionEpoch: 8,
      leaseId: "lease-2",
      leaseTokenHash: "lease-hash-2",
      now: NOW + 1,
    });
    expect(second.history).toEqual(["rev-0", "rev-1", "rev-2"]);
    expect(attributeEvent(second, {
      clientInstanceId: "tab-a",
      effectiveRevision: rev1.effectiveRevision,
      workspaceFingerprint: rev1.workspaceFingerprint,
      presentationEpoch: 2,
    })).toMatchObject({ kind: "attributed", descriptor: rev1 });
    expect(second.descriptors[rev2.effectiveRevision]).toEqual(rev2);
  });
});
