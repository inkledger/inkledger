import type { PresentationDescriptor, Scope } from "./model";
import { APPLY_POLICY_V1 } from "./versions";

export type PresentationStatus = "stable" | "pendingActivation" | "activationUncertain" | "unknown";

export type PresentedRevision = {
  descriptor: PresentationDescriptor;
  presentationEpoch: number;
};

export type PendingActivation = {
  leaseId: string;
  leaseTokenHash: string;
  leaseExpiresAt: number;
  activationId?: string;
  activationExpiresAt?: number;
  descriptor: PresentationDescriptor;
  draftRevision: number;
  interactionEpoch: number;
  presentationEpoch: number;
};

export type PresentationState = {
  clientInstanceId: string;
  status: PresentationStatus;
  lastIssuedEpoch: number;
  presented?: PresentedRevision;
  pending?: PendingActivation;
};

export type PreparedRevision = {
  prepareId: string;
  clientInstanceId: string;
  baseRevision: string;
  draftRevision: number;
  interactionEpoch: number;
  descriptor: PresentationDescriptor;
  expiresAt: number;
};

export type ApplyState = {
  scope: Scope;
  committedRevision: string | null;
  committedDescriptor: PresentationDescriptor | null;
  prepared: PreparedRevision | null;
  presentations: Readonly<Record<string, PresentationState>>;
  history: readonly string[];
  operationIds: readonly string[];
  descriptors: Readonly<Record<string, PresentationDescriptor>>;
};

export type EventAttribution =
  | { kind: "attributed"; descriptor: PresentationDescriptor; presentationStatus: PresentationStatus }
  | { kind: "isolated"; reason: "presentation-proof-mismatch" | "unknown-client" };

export type SsrDecision =
  | { kind: "present"; descriptor: PresentationDescriptor }
  | { kind: "activate"; descriptor: PresentationDescriptor }
  | { kind: "reconcile"; reason: PresentationStatus }
  | { kind: "empty" };

export class WorkspaceApplyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function withDescriptor(state: ApplyState, descriptor: PresentationDescriptor): ApplyState {
  return {
    ...state,
    descriptors: { ...state.descriptors, [descriptor.effectiveRevision]: descriptor },
  };
}

function withPresentation(state: ApplyState, presentation: PresentationState): ApplyState {
  return {
    ...state,
    presentations: { ...state.presentations, [presentation.clientInstanceId]: presentation },
  };
}

function nextPresentationEpoch(current: PresentationState | undefined): number {
  return Math.max(
    current?.lastIssuedEpoch ?? 0,
    current?.presented?.presentationEpoch ?? 0,
    current?.pending?.presentationEpoch ?? 0,
  ) + 1;
}

function isStaleBase(state: ApplyState, baseRevision: string): boolean {
  return state.committedRevision !== baseRevision && !(state.committedRevision === null && baseRevision === "default");
}

export function initialApplyState(scope: Scope, committedDescriptor?: PresentationDescriptor): ApplyState {
  return {
    scope,
    committedRevision: committedDescriptor?.sourceActiveRevision ?? null,
    committedDescriptor: committedDescriptor ?? null,
    prepared: null,
    presentations: {},
    history: committedDescriptor ? [committedDescriptor.sourceActiveRevision] : [],
    operationIds: [],
    descriptors: committedDescriptor ? { [committedDescriptor.effectiveRevision]: committedDescriptor } : {},
  };
}

export function withPresented(
  state: ApplyState,
  clientInstanceId: string,
  descriptor: PresentationDescriptor,
  presentationEpoch = 1,
): ApplyState {
  const next = withDescriptor(state, descriptor);
  return withPresentation(next, {
    clientInstanceId,
    status: "stable",
    lastIssuedEpoch: presentationEpoch,
    presented: { descriptor, presentationEpoch },
  });
}

export function prepare(
  state: ApplyState,
  input: {
    prepareId: string;
    clientInstanceId: string;
    baseRevision: string;
    draftRevision: number;
    interactionEpoch: number;
    descriptor: PresentationDescriptor;
    now: number;
  },
): ApplyState {
  if (state.prepared?.prepareId === input.prepareId) return state;
  if (isStaleBase(state, input.baseRevision)) throw new WorkspaceApplyError("stale-base-revision");
  if (input.descriptor.sourceActiveRevision === state.committedRevision) throw new WorkspaceApplyError("revision-already-committed");
  const prepared: PreparedRevision = {
    prepareId: input.prepareId,
    clientInstanceId: input.clientInstanceId,
    baseRevision: input.baseRevision,
    draftRevision: input.draftRevision,
    interactionEpoch: input.interactionEpoch,
    descriptor: input.descriptor,
    expiresAt: input.now + APPLY_POLICY_V1.preparedTtlMs,
  };
  return { ...withDescriptor(state, input.descriptor), prepared };
}

export function commit(
  state: ApplyState,
  input: {
    prepareId: string;
    operationId: string;
    clientInstanceId: string;
    draftRevision: number;
    interactionEpoch: number;
    leaseId: string;
    leaseTokenHash: string;
    now: number;
  },
): ApplyState {
  if (state.operationIds.includes(input.operationId)) return state;
  const prepared = state.prepared;
  if (!prepared || prepared.prepareId !== input.prepareId) throw new WorkspaceApplyError("prepare-not-found");
  if (prepared.expiresAt <= input.now) throw new WorkspaceApplyError("prepare-expired");
  if (prepared.clientInstanceId !== input.clientInstanceId || prepared.draftRevision !== input.draftRevision || prepared.interactionEpoch !== input.interactionEpoch) {
    throw new WorkspaceApplyError("prepare-precondition-changed");
  }
  if (isStaleBase(state, prepared.baseRevision)) throw new WorkspaceApplyError("stale-base-revision");
  const current = state.presentations[input.clientInstanceId];
  if (current?.pending) throw new WorkspaceApplyError("activation-already-pending");
  const presentationEpoch = nextPresentationEpoch(current);
  const pending: PendingActivation = {
    leaseId: input.leaseId,
    leaseTokenHash: input.leaseTokenHash,
    leaseExpiresAt: input.now + APPLY_POLICY_V1.activationLeaseTtlMs,
    descriptor: prepared.descriptor,
    draftRevision: input.draftRevision,
    interactionEpoch: input.interactionEpoch,
    presentationEpoch,
  };
  const committedState: ApplyState = {
    ...state,
    committedRevision: prepared.descriptor.sourceActiveRevision,
    committedDescriptor: prepared.descriptor,
    prepared: null,
    history: [...state.history, prepared.descriptor.sourceActiveRevision],
    operationIds: [...state.operationIds, input.operationId],
  };
  return withPresentation(committedState, {
    clientInstanceId: input.clientInstanceId,
    status: "pendingActivation",
    lastIssuedEpoch: pending.presentationEpoch,
    presented: current?.presented,
    pending,
  });
}

export function renewActivationLease(
  state: ApplyState,
  input: {
    clientInstanceId: string;
    draftRevision: number;
    interactionEpoch: number;
    leaseId: string;
    leaseTokenHash: string;
    now: number;
  },
): ApplyState {
  const descriptor = state.committedDescriptor;
  if (!descriptor) throw new WorkspaceApplyError("committed-revision-not-found");
  const current = state.presentations[input.clientInstanceId];
  if (current?.pending?.activationId) throw new WorkspaceApplyError("activation-reconciliation-required");
  if (current?.pending && current.pending.leaseExpiresAt > input.now) {
    throw new WorkspaceApplyError("activation-already-pending");
  }
  const pending: PendingActivation = {
    leaseId: input.leaseId,
    leaseTokenHash: input.leaseTokenHash,
    leaseExpiresAt: input.now + APPLY_POLICY_V1.activationLeaseTtlMs,
    descriptor,
    draftRevision: input.draftRevision,
    interactionEpoch: input.interactionEpoch,
    presentationEpoch: nextPresentationEpoch(current),
  };
  return withPresentation(state, {
    clientInstanceId: input.clientInstanceId,
    status: "pendingActivation",
    lastIssuedEpoch: pending.presentationEpoch,
    presented: current?.presented,
    pending,
  });
}

export function deferActivation(state: ApplyState, clientInstanceId: string, interactionEpoch: number): ApplyState {
  const current = state.presentations[clientInstanceId];
  if (!current?.pending) return state;
  if (current.pending.activationId) throw new WorkspaceApplyError("activation-reconciliation-required");
  if (current.pending.interactionEpoch !== interactionEpoch) throw new WorkspaceApplyError("interaction-epoch-changed");
  return withPresentation(state, {
    clientInstanceId,
    status: current.presented ? "stable" : "unknown",
    lastIssuedEpoch: current.lastIssuedEpoch,
    presented: current.presented,
  });
}

export function beginActivation(
  state: ApplyState,
  input: {
    clientInstanceId: string;
    interactionEpoch: number;
    activationId: string;
    leaseTokenHash: string;
    now: number;
  },
): ApplyState {
  const current = state.presentations[input.clientInstanceId];
  const pending = current?.pending;
  if (!pending) throw new WorkspaceApplyError("activation-lease-not-found");
  if (pending.activationId === input.activationId) return state;
  if (pending.activationId) throw new WorkspaceApplyError("activation-already-started");
  if (pending.leaseExpiresAt <= input.now) throw new WorkspaceApplyError("activation-lease-expired");
  if (pending.leaseTokenHash !== input.leaseTokenHash) throw new WorkspaceApplyError("activation-lease-mismatch");
  if (pending.interactionEpoch !== input.interactionEpoch) throw new WorkspaceApplyError("interaction-epoch-changed");
  // A newer commit (another tab) superseded this lease: activating it would show an old layout as new.
  if (state.committedRevision !== null && pending.descriptor.sourceActiveRevision !== state.committedRevision) throw new WorkspaceApplyError("activation-superseded");
  return withPresentation(state, {
    ...current,
    pending: {
      ...pending,
      activationId: input.activationId,
      activationExpiresAt: input.now + APPLY_POLICY_V1.pendingActivationTtlMs,
    },
  });
}

export function acknowledgeActivation(
  state: ApplyState,
  input: {
    clientInstanceId: string;
    activationId: string;
    effectiveRevision: string;
    workspaceFingerprint: string;
    presentationEpoch: number;
  },
): ApplyState {
  const current = state.presentations[input.clientInstanceId];
  if (!current) throw new WorkspaceApplyError("presentation-not-found");
  if (!current.pending && current.presented?.descriptor.effectiveRevision === input.effectiveRevision && current.presented.presentationEpoch === input.presentationEpoch) {
    return state;
  }
  const pending = current.pending;
  if (!pending?.activationId || pending.activationId !== input.activationId) throw new WorkspaceApplyError("activation-not-found");
  if (pending.descriptor.effectiveRevision !== input.effectiveRevision || pending.descriptor.workspaceFingerprint !== input.workspaceFingerprint) {
    throw new WorkspaceApplyError("activation-fingerprint-mismatch");
  }
  if (pending.presentationEpoch !== input.presentationEpoch) throw new WorkspaceApplyError("presentation-epoch-mismatch");
  if ((current.presented?.presentationEpoch ?? 0) > input.presentationEpoch) throw new WorkspaceApplyError("stale-presentation-epoch");
  return withPresentation(state, {
    clientInstanceId: input.clientInstanceId,
    status: "stable",
    lastIssuedEpoch: Math.max(current.lastIssuedEpoch, input.presentationEpoch),
    presented: { descriptor: pending.descriptor, presentationEpoch: input.presentationEpoch },
  });
}

export function reconcilePresentation(
  state: ApplyState,
  input: {
    clientInstanceId: string;
    effectiveRevision: string;
    workspaceFingerprint: string;
    presentationEpoch: number;
  },
): ApplyState {
  const current = state.presentations[input.clientInstanceId];
  if (!current) throw new WorkspaceApplyError("presentation-not-found");
  const descriptor = state.descriptors[input.effectiveRevision];
  if (!descriptor || descriptor.workspaceFingerprint !== input.workspaceFingerprint) throw new WorkspaceApplyError("presentation-proof-mismatch");
  const pendingMatches = current.pending?.descriptor.effectiveRevision === input.effectiveRevision && current.pending.presentationEpoch === input.presentationEpoch;
  const presentedMatches = current.presented?.descriptor.effectiveRevision === input.effectiveRevision && current.presented.presentationEpoch === input.presentationEpoch;
  if (!pendingMatches && !presentedMatches) throw new WorkspaceApplyError("stale-presentation-epoch");
  return withPresentation(state, {
    clientInstanceId: input.clientInstanceId,
    status: "stable",
    lastIssuedEpoch: Math.max(current.lastIssuedEpoch, input.presentationEpoch),
    presented: { descriptor, presentationEpoch: input.presentationEpoch },
  });
}

/** Time-driven transitions only; what did not change keeps its identity, so callers can tell what to write. */
export function expire(state: ApplyState, now: number): ApplyState {
  let next = state.prepared && state.prepared.expiresAt <= now ? { ...state, prepared: null } : state;
  const presentations = Object.values(next.presentations).map(current => {
    const pending = current.pending;
    if (!pending) return current;
    if (pending.activationId === undefined && pending.leaseExpiresAt <= now) {
      return {
        clientInstanceId: current.clientInstanceId,
        status: current.presented ? "stable" as const : "unknown" as const,
        lastIssuedEpoch: current.lastIssuedEpoch,
        presented: current.presented,
      };
    }
    if (pending.activationExpiresAt !== undefined && pending.activationExpiresAt <= now) {
      const uncertainUntil = pending.activationExpiresAt + APPLY_POLICY_V1.activationUncertainRetentionMs;
      const status = now >= uncertainUntil ? "unknown" as const : "activationUncertain" as const;
      return status === current.status ? current : { ...current, status };
    }
    return current;
  });
  for (const presentation of presentations) {
    if (presentation !== next.presentations[presentation.clientInstanceId]) next = withPresentation(next, presentation);
  }
  return next;
}

export function attributeEvent(
  state: ApplyState,
  input: {
    clientInstanceId: string;
    effectiveRevision: string;
    workspaceFingerprint: string;
    presentationEpoch: number;
    activationId?: string;
  },
): EventAttribution {
  const current = state.presentations[input.clientInstanceId];
  if (!current) return { kind: "isolated", reason: "unknown-client" };
  if (current.presented?.descriptor.effectiveRevision === input.effectiveRevision && current.presented.descriptor.workspaceFingerprint === input.workspaceFingerprint && current.presented.presentationEpoch === input.presentationEpoch) {
    return { kind: "attributed", descriptor: current.presented.descriptor, presentationStatus: current.status };
  }
  if (current.pending?.activationId && current.pending.activationId === input.activationId && current.pending.descriptor.effectiveRevision === input.effectiveRevision && current.pending.descriptor.workspaceFingerprint === input.workspaceFingerprint && current.pending.presentationEpoch === input.presentationEpoch) {
    return { kind: "attributed", descriptor: current.pending.descriptor, presentationStatus: current.status };
  }
  return { kind: "isolated", reason: "presentation-proof-mismatch" };
}

export function ssrDecision(state: ApplyState, clientInstanceId: string): SsrDecision {
  const current = state.presentations[clientInstanceId];
  if (!current) return state.committedDescriptor ? { kind: "activate", descriptor: state.committedDescriptor } : { kind: "empty" };
  if (current.status === "stable" && current.presented) return { kind: "present", descriptor: current.presented.descriptor };
  return { kind: "reconcile", reason: current.status };
}

/**
 * A page load keeps no React state, like a new tab (§15.6): a stable presentation behind the layout
 * the user saved moves to it, with a new epoch. Pending or uncertain ones keep their reconcile path.
 */
export function pageLoadPresentation(state: ApplyState, clientInstanceId: string, target: PresentationDescriptor): PresentationState | null {
  const current = state.presentations[clientInstanceId];
  if (!current || current.status !== "stable" || !current.presented) return null;
  if (current.presented.descriptor.effectiveRevision === target.effectiveRevision) return null;
  const epoch = current.lastIssuedEpoch + 1;
  return { clientInstanceId, status: "stable", lastIssuedEpoch: epoch, presented: { descriptor: target, presentationEpoch: epoch } };
}

export function rollbackPreview(state: ApplyState, clientInstanceId: string, targetRevision: string): {
  targetRevision: string;
  presentedRevision: string | null;
  requiresPrepare: true;
} {
  if (!state.history.includes(targetRevision)) throw new WorkspaceApplyError("rollback-target-not-found");
  return {
    targetRevision,
    presentedRevision: state.presentations[clientInstanceId]?.presented?.descriptor.sourceActiveRevision ?? null,
    requiresPrepare: true,
  };
}
