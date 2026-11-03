import { t } from "@contracts/i18n";
import { TRPCError } from "@trpc/server";
import {
  acknowledgeActivation,
  beginActivation,
  commit,
  deferActivation,
  expire,
  pageLoadPresentation,
  reconcilePresentation,
  renewActivationLease,
  rollbackPreview,
  ssrDecision,
  WorkspaceApplyError,
  type ApplyState,
  type PresentationState,
} from "@contracts/workspace/applyMachine";
import { CATALOG_V1, PRODUCT_DEFAULTS_V1, PRODUCT_MIGRATIONS_V1 } from "@contracts/workspace/catalogV1";
import { assertCatalogManifest, assertProductDefaults, productDefaultFor, scopeFor } from "@contracts/workspace/catalog";
import { resolve } from "@contracts/workspace/resolve";
import { rollbackOperations } from "@contracts/workspace/rollback";
import { reproposeDisjoint } from "@contracts/workspace/repropose";
import { StaleDraftError } from "./staleDraft";
import { fingerprint } from "./crypto";
import { hashActivationToken, newActivationToken } from "./lease";
import { getDiscoveryState, updateDiscoveryState } from "./discovery";
import { importHasUnknownContent, plannerFeedback } from "./plannerStore";
import { recordWorkspaceCommitted, recordWorkspaceDiscovery, recordWorkspacePresented } from "./flowAttribution";
import {
  commitRevision,
  operationResponse,
  latestDraft,
  latestRevision,
  revisionById,
  loadApplyState,
  saveDescriptor,
  upsertDraft,
  upsertPrepared,
  writePresentation,
  insertSeedRevision,
  revisionSummaries,
} from "./store";
import type {
  ActiveRevision,
  Draft,
  LayoutOperation,
  PresentationDescriptor,
  ResolvedWorkspace,
  ResolveInput,
  ResolveResult,
  Scope,
} from "@contracts/workspace/model";

// The shipped catalogue is checked here, once, when the server starts: a broken one never serves a layout.
assertCatalogManifest(CATALOG_V1);
assertProductDefaults(CATALOG_V1, PRODUCT_DEFAULTS_V1, PRODUCT_MIGRATIONS_V1);

function defaultRevision(scope: Scope): ActiveRevision {
  return {
    revisionId: "default",
    scope,
    catalogVersion: CATALOG_V1.catalogVersion,
    productDefaultVersion: CATALOG_V1.productDefaultVersion,
    committedAt: 0,
    operations: [],
    constraints: [],
    opaque: [],
  };
}

async function feedback(userId: number): Promise<ResolveInput["feedback"]> {
  return plannerFeedback(userId);
}

async function discoveryFor(userId: number, scope: Scope): Promise<ResolveInput["discoveryState"]> {
  return getDiscoveryState(userId, scope);
}

/** Drafts still being worked on; an applied, discarded or aborted one is history and never resolved again. */
const OPEN_DRAFT: readonly Draft["status"][] = ["editing", "ready", "applying", "conflict", "stale"];

async function openDraft(userId: number, scope: Scope): Promise<Draft | null> {
  const draft = await latestDraft(userId, scope);
  return draft && OPEN_DRAFT.includes(draft.status) ? draft : null;
}

async function inputFor(userId: number, scope: Scope, draftOverride?: Draft | null, activeOverride?: ActiveRevision): Promise<ResolveInput> {
  scopeFor(CATALOG_V1, scope.surfaceId, scope.deviceClass);
  const activeRevision = activeOverride ?? (await latestRevision(userId, scope)) ?? defaultRevision(scope);
  const draft = draftOverride === undefined ? await openDraft(userId, scope) : draftOverride;
  return {
    catalog: CATALOG_V1,
    productDefault: productDefaultFor(PRODUCT_DEFAULTS_V1, scope.surfaceId),
    activeRevision,
    draft,
    explicitConstraints: activeRevision.constraints,
    feedback: await feedback(userId),
    discoveryState: await discoveryFor(userId, scope),
    migrations: PRODUCT_MIGRATIONS_V1,
  };
}

function rendererBindingsOf(surfaceId: Scope["surfaceId"]) {
  const anchors = new Set(CATALOG_V1.anchors.filter(anchor => anchor.surfaceId === surfaceId).map(anchor => anchor.id));
  return CATALOG_V1.rendererBindings.filter(binding => anchors.has(binding.anchorId));
}

function descriptorFor(workspace: Extract<ResolveResult, { kind: "resolved" }>["workspace"], input: ResolveInput): PresentationDescriptor {
  const workspaceFingerprint = fingerprint("workspace", { ...workspace, sourceActiveRevision: undefined }).value;
  const base = {
    sourceActiveRevision: workspace.sourceActiveRevision,
    workspaceFingerprint,
    productDefaultVersion: workspace.productDefaultVersion,
    catalogVersion: workspace.catalogVersion,
    resolverVersion: workspace.resolverVersion,
    constraintsFingerprint: fingerprint("constraints", input.activeRevision.constraints).value,
    feedbackFingerprint: fingerprint("feedback", input.feedback).value,
    discoveryFingerprint: fingerprint("discovery", input.discoveryState).value,
    // This surface's own blocks only: a block added to another page never changes this one's layout.
    rendererBindingsFingerprint: fingerprint("renderer-bindings", rendererBindingsOf(input.activeRevision.scope.surfaceId)).value,
  };
  const presentationInput = {
    sourceActiveRevision: base.sourceActiveRevision,
    workspaceFingerprint: base.workspaceFingerprint,
    productDefaultVersion: base.productDefaultVersion,
    catalogVersion: base.catalogVersion,
    resolverVersion: base.resolverVersion,
    constraintsFingerprint: base.constraintsFingerprint,
    discoveryFingerprint: base.discoveryFingerprint,
    rendererBindingsFingerprint: base.rendererBindingsFingerprint,
  };
  return { ...base, effectiveRevision: `eff_${fingerprint("presentation", presentationInput).value}` };
}

function resolvedOrThrow(result: ResolveResult) {
  if (result.kind === "conflicts") {
    throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.unresolved"), cause: result.conflicts });
  }
  return result.workspace;
}

async function resolvedFor(userId: number, scope: Scope, draftOverride?: Draft | null, activeOverride?: ActiveRevision) {
  const input = await inputFor(userId, scope, draftOverride, activeOverride);
  const workspace = resolvedOrThrow(resolve(input));
  return { input, workspace, descriptor: descriptorFor(workspace, input) };
}

/**
 * The stored state and what time alone makes of it. Reading never writes: a transition writes only
 * its own client's row, and only if that row is still the stored one (see writePresentation).
 */
async function currentState(userId: number, scope: Scope, prepareId?: string): Promise<{ stored: ApplyState; state: ApplyState }> {
  const stored = await loadApplyState(userId, scope, prepareId);
  return { stored, state: expire(stored, Date.now()) };
}

/** Persists the transition of one client's presentation, against the row it was computed from. */
async function savePresentation(userId: number, scope: Scope, stored: ApplyState, next: PresentationState | undefined, missing: string): Promise<PresentationState> {
  if (!next) throw new TRPCError({ code: "PRECONDITION_FAILED", message: missing });
  await writePresentation(userId, scope, stored.presentations[next.clientInstanceId] ?? null, next);
  return next;
}

export async function getWorkspace(userId: number, scope: Scope, clientInstanceId?: string) {
  const { state } = await currentState(userId, scope);
  const serverRender = clientInstanceId === "ssr";
  let presentation = clientInstanceId && !serverRender ? state.presentations[clientInstanceId] ?? null : null;
  const sourceRevision = presentation?.presented?.descriptor.sourceActiveRevision;
  const active = sourceRevision === "default" ? defaultRevision(scope) : sourceRevision ? await revisionById(userId, scope, sourceRevision) ?? undefined : undefined;
  const resolved = await resolvedFor(userId, scope, null, active);
  const ssr = clientInstanceId
    ? serverRender
      ? { kind: "activate", descriptor: resolved.descriptor } as const
      : state.committedDescriptor
        ? ssrDecision(state, clientInstanceId)
        : { kind: "activate", descriptor: resolved.descriptor } as const
    : null;
  if (clientInstanceId && !serverRender && !presentation && ssr?.kind === "activate") {
    // A tab's first look at a live scope: the one write a read makes, once, so later events and acks have a proof.
    presentation = {
      clientInstanceId,
      status: "stable",
      lastIssuedEpoch: 1,
      presented: { descriptor: ssr.descriptor, presentationEpoch: 1 },
    };
    try {
      await writePresentation(userId, scope, null, presentation, ssr.descriptor);
    } catch (error) {
      if (!(error instanceof WorkspaceApplyError)) throw error;
      // The same tab asked twice at once: the other request stored it.
      presentation = (await loadApplyState(userId, scope)).presentations[clientInstanceId] ?? presentation;
    }
  }
  const storedDraft = await latestDraft(userId, scope);
  const draft = storedDraft && !["applied", "discarded", "aborted"].includes(storedDraft.status) ? storedDraft : null;
  let draftDescriptor: PresentationDescriptor | null = null;
  let draftWorkspace: ResolvedWorkspace | null = null;
  if (draft) {
    const input = await inputFor(userId, scope, draft);
    const preview = resolve(input);
    if (preview.kind === "resolved") {
      draftDescriptor = descriptorFor(preview.workspace, input);
      draftWorkspace = preview.workspace;
    }
  }
  // The layout a page load would show now: a tab presenting another one (saved elsewhere, or the same
  // revision drawn differently since, e.g. a block seen) is moved by openPage, so its events keep counting.
  const latest = active ? await resolvedFor(userId, scope, null) : resolved;
  return {
    ...resolved,
    descriptor: presentation?.presented?.descriptor ?? resolved.descriptor,
    currentEffectiveRevision: latest.descriptor.effectiveRevision,
    committedRevision: state.committedRevision,
    presentation,
    ssr,
    history: state.history,
    revisions: await revisionSummaries(userId, scope),
    draft,
    draftDescriptor,
    draftWorkspace,
    constraints: resolved.input.activeRevision.constraints,
  };
}

/**
 * The first look of a page load at a scope: a tab still presenting a layout older than the saved one
 * (saved in another tab, or one that could not resolve back then) moves to it, as a new tab would.
 */
export async function openWorkspacePage(userId: number, scope: Scope, clientInstanceId: string): Promise<PresentationState | null> {
  const { stored, state } = await currentState(userId, scope);
  if (!state.presentations[clientInstanceId]) return null;
  const target = await resolvedFor(userId, scope, null);
  const next = pageLoadPresentation(state, clientInstanceId, target.descriptor);
  if (!next) return null;
  await writePresentation(userId, scope, stored.presentations[clientInstanceId] ?? null, next, target.descriptor);
  await recordWorkspacePresented(userId, scope, next).catch(() => {});
  return next;
}

/** An imported document with content this version cannot read stays read-only: never prepared nor committed (§19.4). */
async function refuseUnknownContent(userId: number, scope: Scope): Promise<void> {
  const draft = await latestDraft(userId, scope);
  if (draft && await importHasUnknownContent(userId, scope, draft.draftId)) throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.readOnly") });
}

export async function saveWorkspaceDraft(userId: number, scope: Scope, draft: Draft) {
  if (draft.scope.surfaceId !== scope.surfaceId || draft.scope.deviceClass !== scope.deviceClass) {
    throw new TRPCError({ code: "BAD_REQUEST", message: t("server.workspace.invalidRequest") });
  }
  if (await importHasUnknownContent(userId, scope, draft.draftId)) throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.readOnly") });
  const previous = await latestDraft(userId, scope);
  if (previous?.draftId === draft.draftId && (draft.draftRevision < previous.draftRevision || (draft.draftRevision === previous.draftRevision && fingerprint("input", previous.patches).value !== fingerprint("input", draft.patches).value))) {
    throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.changed") });
  }
  if (previous && !["applied", "discarded", "aborted"].includes(previous.status) && previous.draftId !== draft.draftId && draft.draftRevision <= previous.draftRevision) {
    throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.changed") });
  }
  const active = await inputFor(userId, scope, null);
  if (draft.baseRevision !== active.activeRevision.revisionId) {
    // Made on an older layout: refused as before, saying how much of it the user could keep (reproposeWorkspaceDraft).
    const { operations } = await reproposalFor(userId, scope, draft, active);
    throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.changed"), cause: new StaleDraftError({ keepable: operations.length }) });
  }
  // resolvedFor throws on conflicts: what is saved always resolves.
  const result = await resolvedFor(userId, scope, draft);
  const saved: Draft = { ...draft, status: "ready" };
  await upsertDraft(userId, saved, previous);
  return { draft: saved, preview: result };
}

/** What was committed since a draft's base: the current revision's operations its base did not hold (all of them for an unknown base). */
async function committedSince(userId: number, scope: Scope, baseRevision: string, current: ActiveRevision): Promise<LayoutOperation[]> {
  const base = baseRevision === "default" ? defaultRevision(scope) : await revisionById(userId, scope, baseRevision);
  const known = new Set((base?.operations ?? []).map(item => item.operation.operationId));
  return current.operations.filter(item => !known.has(item.operation.operationId)).map(item => item.operation);
}

async function reproposalFor(userId: number, scope: Scope, draft: Draft, current: ResolveInput) {
  return reproposeDisjoint(draft, await committedSince(userId, scope, draft.baseRevision, current.activeRevision), current);
}

/**
 * A draft made on an older layout, proposed again on the current one with only its changes disjoint
 * from what was committed since (§21 #16): written as the scope's new draft, a preview like any other,
 * never applied nor committed here (D-54). The changes left out are listed. Another tab's open draft is
 * never replaced, and nothing is written when no change can be kept.
 */
export async function reproposeWorkspaceDraft(userId: number, scope: Scope, draft: Draft) {
  if (draft.scope.surfaceId !== scope.surfaceId || draft.scope.deviceClass !== scope.deviceClass) {
    throw new TRPCError({ code: "BAD_REQUEST", message: t("server.workspace.invalidRequest") });
  }
  if (await importHasUnknownContent(userId, scope, draft.draftId)) throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.readOnly") });
  const current = await inputFor(userId, scope, null);
  if (draft.baseRevision === current.activeRevision.revisionId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.workspace.changed") });
  const previous = await latestDraft(userId, scope);
  if (previous && OPEN_DRAFT.includes(previous.status) && previous.draftId !== draft.draftId) {
    throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.changed") });
  }
  const { patches, operations, dropped } = await reproposalFor(userId, scope, draft, current);
  if (operations.length === 0) return { draft: null, preview: null, dropped };
  const next: Draft = {
    draftId: `draft_${newActivationToken()}`,
    draftRevision: Math.max(draft.draftRevision, previous?.draftRevision ?? 0) + 1,
    baseRevision: current.activeRevision.revisionId,
    scope,
    patches,
    status: "ready",
  };
  // resolvedFor throws on conflicts: what is proposed always resolves.
  const { workspace, descriptor } = await resolvedFor(userId, scope, next);
  // Under the scope's draft lock, and only over the draft read above: a tab that saved meanwhile wins.
  await upsertDraft(userId, next, previous);
  return { draft: next, preview: { workspace, descriptor }, dropped };
}

export async function completeWorkspaceDraft(userId: number, scope: Scope, draftId: string, draftRevision?: number) {
  const draft = await latestDraft(userId, scope);
  // A revision saved while the earlier one was committing is still the user's open work, not applied.
  if (!draft || draft.draftId !== draftId || !["editing", "ready", "applying"].includes(draft.status) || (draftRevision !== undefined && draft.draftRevision !== draftRevision)) return;
  await upsertDraft(userId, { ...draft, status: "applied" }, draft);
}

const ROLLBACK_DRAFT = "rollback_";

export async function discardWorkspaceDraft(userId: number, scope: Scope, draftId: string) {
  const draft = await latestDraft(userId, scope);
  // A rollback is a preview the server never stored until edited: dropping it leaves nothing to mark.
  if ((!draft || draft.draftId !== draftId) && draftId.startsWith(ROLLBACK_DRAFT)) return;
  if (!draft || draft.draftId !== draftId) throw new TRPCError({ code: "NOT_FOUND", message: t("server.workspace.gone") });
  await upsertDraft(userId, { ...draft, status: "discarded" }, draft);
}

export async function prepareWorkspace(input: {
  userId: number;
  scope: Scope;
  prepareId: string;
  clientInstanceId: string;
  draftRevision: number;
  interactionEpoch: number;
}) {
  const { userId, scope, prepareId, clientInstanceId, draftRevision, interactionEpoch } = input;
  await refuseUnknownContent(userId, scope);
  const { descriptor } = await resolvedFor(userId, scope);
  const { state } = await currentState(userId, scope, prepareId);
  const baseRevision = state.committedRevision ?? "default";
  if (state.prepared?.prepareId === prepareId) {
    const existing = state.prepared;
    if (existing.clientInstanceId === clientInstanceId && existing.draftRevision === draftRevision && existing.interactionEpoch === interactionEpoch && existing.baseRevision === baseRevision && existing.descriptor.effectiveRevision === descriptor.effectiveRevision && existing.expiresAt > Date.now()) return existing;
    throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.changed") });
  }
  const prepared = {
    prepareId,
    clientInstanceId,
    baseRevision,
    draftRevision,
    interactionEpoch,
    descriptor,
    expiresAt: Date.now() + 60_000,
  };
  await saveDescriptor(userId, scope, descriptor);
  await upsertPrepared(userId, scope, prepared);
  return prepared;
}

function committedRevisionFrom(input: ResolveInput): ActiveRevision {
  const active = input.activeRevision;
  const operations = [...active.operations];
  const constraints = new Map(active.constraints.map(constraint => [constraint.id, constraint] as const));
  for (const patch of input.draft?.patches ?? []) {
    if (patch.author === "user" && patch.intent.status === "explicit") {
      for (const constraintId of patch.revokedConstraintIds ?? []) {
        if (constraints.get(constraintId)?.author === "user") constraints.delete(constraintId);
      }
    }
    for (const operation of patch.operations) {
      operations.push({ operation, origin: patch.author, acceptedByUser: true, patchId: patch.patchId });
    }
    for (const constraint of patch.proposedConstraints) {
      if (constraint.status === "explicit") constraints.set(constraint.id, constraint);
    }
  }
  return {
    revisionId: `wr_${newActivationToken()}`,
    scope: active.scope,
    catalogVersion: active.catalogVersion,
    productDefaultVersion: active.productDefaultVersion,
    committedAt: Date.now(),
    operations,
    constraints: [...constraints.values()],
    causedByRevision: active.revisionId === "default" ? undefined : active.revisionId,
    opaque: active.opaque,
  };
}

export async function commitWorkspace(input: {
  userId: number;
  scope: Scope;
  prepareId: string;
  operationId: string;
  clientInstanceId: string;
  draftRevision: number;
  interactionEpoch: number;
}) {
  const { userId, scope, prepareId, operationId, clientInstanceId, draftRevision, interactionEpoch } = input;
  const { stored, state } = await currentState(userId, scope, prepareId);
  if (state.operationIds.includes(operationId)) return replayedCommit(userId, scope, operationId, clientInstanceId);
  await refuseUnknownContent(userId, scope);
  const prepared = state.prepared;
  if (!prepared) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.workspace.changed") });
  const { workspace, descriptor } = await resolvedFor(userId, scope);
  if (descriptor.workspaceFingerprint !== prepared.descriptor.workspaceFingerprint) {
    throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.changed") });
  }
  const leaseToken = newActivationToken();
  const next = commit(state, {
    prepareId,
    operationId,
    clientInstanceId,
    draftRevision,
    interactionEpoch,
    leaseId: `lease_${newActivationToken()}`,
    leaseTokenHash: hashActivationToken(leaseToken),
    now: Date.now(),
  });
  const inputForCommit = await inputFor(userId, scope);
  const revision = committedRevisionFrom(inputForCommit);
  const finalDescriptor = descriptorFor({ ...workspace, sourceActiveRevision: revision.revisionId }, inputForCommit);
  const current = next.presentations[clientInstanceId];
  if (!current) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: t("server.workspace.changed") });
  const presentation: typeof current = {
    ...current,
    pending: current.pending ? { ...current.pending, descriptor: finalDescriptor } : undefined,
  };
  const inserted = await commitRevision({
    userId,
    scope,
    revision,
    descriptor: finalDescriptor,
    presentation,
    expectedPresentation: stored.presentations[clientInstanceId] ?? null,
    operationId,
    prepareId,
    baseRevision: state.committedRevision ?? "default",
    draftId: inputForCommit.draft?.draftId ?? null,
    draftRevision,
  });
  // Lost the race to a retry of the same operation: answer what that one stored, never this unsaved revision.
  if (!inserted) return replayedCommit(userId, scope, operationId, clientInstanceId);
  await recordWorkspaceCommitted(userId, scope, clientInstanceId, revision.revisionId).catch(() => {});
  return { committed: true, revision, presentation, leaseToken };
}

/** A commit already done under this operation id: its revision, the client's presentation, and no new lease. */
async function replayedCommit(userId: number, scope: Scope, operationId: string, clientInstanceId: string) {
  const response = await operationResponse(userId, scope, operationId);
  const revisionId = typeof response === "object" && response !== null && "revisionId" in response && typeof response.revisionId === "string" ? response.revisionId : null;
  const revision = revisionId ? await revisionById(userId, scope, revisionId) : null;
  const presentation = (await loadApplyState(userId, scope)).presentations[clientInstanceId] ?? null;
  return { committed: false, revision, presentation, leaseToken: null };
}

export async function activateWorkspace(input: {
  userId: number;
  scope: Scope;
  clientInstanceId: string;
  interactionEpoch: number;
  leaseToken: string;
}) {
  const { userId, scope, clientInstanceId, interactionEpoch, leaseToken } = input;
  const { stored, state } = await currentState(userId, scope);
  const activationId = `activation_${newActivationToken()}`;
  const next = beginActivation(state, {
    clientInstanceId,
    interactionEpoch,
    activationId,
    leaseTokenHash: hashActivationToken(leaseToken),
    now: Date.now(),
  });
  // The swap makes the lease single-use: a second activate with the same token finds the row changed.
  const presentation = await savePresentation(userId, scope, stored, next.presentations[clientInstanceId], t("server.workspace.changed"));
  return { activationId, presentation };
}

export async function renewWorkspaceActivationLease(input: {
  userId: number;
  scope: Scope;
  clientInstanceId: string;
  interactionEpoch: number;
  draftRevision: number;
}) {
  const { userId, scope, clientInstanceId, interactionEpoch, draftRevision } = input;
  const { stored, state } = await currentState(userId, scope);
  const leaseToken = newActivationToken();
  const next = renewActivationLease(state, {
    clientInstanceId,
    interactionEpoch,
    draftRevision,
    leaseId: `lease_${newActivationToken()}`,
    leaseTokenHash: hashActivationToken(leaseToken),
    now: Date.now(),
  });
  const presentation = await savePresentation(userId, scope, stored, next.presentations[clientInstanceId], t("server.workspace.changed"));
  return { leaseToken, presentation };
}

export async function acknowledgeWorkspace(input: {
  userId: number;
  scope: Scope;
  clientInstanceId: string;
  activationId: string;
  effectiveRevision: string;
  workspaceFingerprint: string;
  presentationEpoch: number;
}) {
  const { userId, scope } = input;
  const { stored, state } = await currentState(userId, scope);
  const next = acknowledgeActivation(state, input);
  const presentation = await savePresentation(userId, scope, stored, next.presentations[input.clientInstanceId], t("server.workspace.gone"));
  const draft = await latestDraft(userId, scope);
  await recordWorkspacePresented(userId, scope, presentation, draft?.patches.some(patch => patch.patchId.startsWith("rollback_"))).catch(() => {});
  return presentation;
}

export async function reconcileWorkspace(input: {
  userId: number;
  scope: Scope;
  clientInstanceId: string;
  effectiveRevision: string;
  workspaceFingerprint: string;
  presentationEpoch: number;
}) {
  const { userId, scope } = input;
  const { stored, state } = await currentState(userId, scope);
  const next = reconcilePresentation(state, input);
  return savePresentation(userId, scope, stored, next.presentations[input.clientInstanceId], t("server.workspace.gone"));
}

export async function deferWorkspace(userId: number, scope: Scope, clientInstanceId: string, interactionEpoch: number) {
  const { stored, state } = await currentState(userId, scope);
  const next = deferActivation(state, clientInstanceId, interactionEpoch);
  return savePresentation(userId, scope, stored, next.presentations[clientInstanceId], t("server.workspace.gone"));
}

export async function rollbackWorkspace(userId: number, scope: Scope, clientInstanceId: string, targetRevision: string) {
  const { state } = await currentState(userId, scope);
  const preview = rollbackPreview(state, clientInstanceId, targetRevision);
  const target = targetRevision === "default" ? defaultRevision(scope) : await revisionById(userId, scope, targetRevision);
  if (!target) throw new TRPCError({ code: "NOT_FOUND", message: t("server.workspace.gone") });
  const previousDraft = await latestDraft(userId, scope);
  const targetInput = await inputFor(userId, scope, null);
  targetInput.activeRevision = target;
  targetInput.explicitConstraints = target.constraints;
  const targetWorkspace = resolvedOrThrow(resolve(targetInput));
  const current = await resolvedFor(userId, scope, null);
  // The user's constraints made after the target go with the undo (D-51); kept ones would block it.
  const targetConstraints = new Set(target.constraints.map(constraint => constraint.id));
  const revokedConstraintIds = current.input.activeRevision.constraints
    .filter(constraint => constraint.author === "user" && constraint.status === "explicit" && !targetConstraints.has(constraint.id))
    .map(constraint => constraint.id);
  const patch = {
    patchId: `rollback_${newActivationToken()}`,
    patchSchemaVersion: 1,
    scope,
    baseRevision: state.committedRevision ?? "default",
    catalogVersion: current.workspace.catalogVersion,
    author: "user" as const,
    provenance: { parentPatchId: targetRevision },
    intent: { kind: "custom" as const, status: "explicit" as const },
    operations: rollbackOperations(current.workspace, targetWorkspace, () => `op_${newActivationToken()}`),
    evidence: [],
    proposedConstraints: [],
    ...(revokedConstraintIds.length > 0 ? { revokedConstraintIds } : {}),
    causalParentRevision: targetRevision,
  };
  const draft: Draft = {
    draftId: `${ROLLBACK_DRAFT}${newActivationToken()}`,
    draftRevision: (previousDraft?.draftRevision ?? 0) + 1,
    baseRevision: state.committedRevision ?? "default",
    scope,
    patches: [patch],
    status: "ready",
  };
  return { ...preview, draft, candidate: await resolvedFor(userId, scope, draft) };
}

export async function markWorkspaceDiscovery(userId: number, scope: Scope, state: ResolveInput["discoveryState"], clientInstanceId?: string) {
  scopeFor(CATALOG_V1, scope.surfaceId, scope.deviceClass);
  const known = new Set(CATALOG_V1.anchors.filter(anchor => anchor.surfaceId === scope.surfaceId).map(anchor => anchor.id));
  const knownAreas = new Set(CATALOG_V1.areas.filter(area => area.surfaceId === scope.surfaceId).map(area => area.id));
  if ([...state.seenAnchorIds, ...state.placedAnchorIds, ...state.dismissedAnchorIds].some(anchorId => !known.has(anchorId))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: t("server.workspace.invalidRequest") });
  }
  if ([...state.seenAreaIds ?? [], ...state.placedAreaIds ?? [], ...state.dismissedAreaIds ?? []].some(areaId => !knownAreas.has(areaId))) {
    throw new TRPCError({ code: "BAD_REQUEST", message: t("server.workspace.invalidRequest") });
  }
  const { previous } = await updateDiscoveryState(userId, scope, previous => {
    const placed = new Set([...previous.placedAnchorIds, ...state.placedAnchorIds]);
    const dismissed = new Set([...previous.dismissedAnchorIds, ...state.dismissedAnchorIds].filter(anchorId => !placed.has(anchorId)));
    const seen = new Set([...previous.seenAnchorIds, ...state.seenAnchorIds, ...placed, ...dismissed]);
    const placedAreas = new Set([...previous.placedAreaIds ?? [], ...state.placedAreaIds ?? []]);
    const dismissedAreas = new Set([...previous.dismissedAreaIds ?? [], ...state.dismissedAreaIds ?? []].filter(areaId => !placedAreas.has(areaId)));
    const seenAreas = new Set([...previous.seenAreaIds ?? [], ...state.seenAreaIds ?? [], ...placedAreas, ...dismissedAreas]);
    return {
      seenAnchorIds: [...seen],
      placedAnchorIds: [...placed],
      dismissedAnchorIds: [...dismissed],
      seenAreaIds: [...seenAreas],
      placedAreaIds: [...placedAreas],
      dismissedAreaIds: [...dismissedAreas],
    };
  });
  if (clientInstanceId) {
    for (const anchorId of state.seenAnchorIds.filter(anchorId => !previous.seenAnchorIds.includes(anchorId))) await recordWorkspaceDiscovery(userId, scope, clientInstanceId, "seen", anchorId).catch(() => {});
    for (const anchorId of state.placedAnchorIds.filter(anchorId => !previous.placedAnchorIds.includes(anchorId))) await recordWorkspaceDiscovery(userId, scope, clientInstanceId, "placed", anchorId).catch(() => {});
    for (const areaId of (state.seenAreaIds ?? []).filter(areaId => !(previous.seenAreaIds ?? []).includes(areaId))) await recordWorkspaceDiscovery(userId, scope, clientInstanceId, "seen", areaId, "area").catch(() => {});
    for (const areaId of (state.placedAreaIds ?? []).filter(areaId => !(previous.placedAreaIds ?? []).includes(areaId))) await recordWorkspaceDiscovery(userId, scope, clientInstanceId, "placed", areaId, "area").catch(() => {});
  }
  return resolvedFor(userId, scope, null);
}

export async function workspaceAtDescriptor(userId: number, scope: Scope, effectiveRevision: string) {
  const { state } = await currentState(userId, scope);
  const descriptor = state.descriptors[effectiveRevision];
  if (!descriptor) {
    // Never stored because nobody committed or activated it (reads write nothing): the current
    // presentation is deterministic, so it is recognised by its effective revision alone.
    const current = await resolvedFor(userId, scope, null);
    return current.descriptor.effectiveRevision === effectiveRevision ? { workspace: current.workspace, descriptor: current.descriptor } : null;
  }
  const active = descriptor.sourceActiveRevision === "default"
    ? defaultRevision(scope)
    : await revisionById(userId, scope, descriptor.sourceActiveRevision);
  if (!active) return null;
  const input = await inputFor(userId, scope, null);
  input.activeRevision = active;
  input.explicitConstraints = active.constraints;
  const workspace = resolvedOrThrow(resolve(input));
  const actual = descriptorFor(workspace, input);
  if (actual.workspaceFingerprint !== descriptor.workspaceFingerprint || actual.catalogVersion !== descriptor.catalogVersion) {
    throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.oldView") });
  }
  return { workspace, descriptor };
}

/**
 * The Dashboard sections a user hid before the workspace existed (settings.dashboard): the same
 * choice, made theirs again as a first revision of each Dashboard scope. Nothing when none is hidden
 * or the scope already has a layout.
 */
export async function seedLegacyDashboard(userId: number, hiddenAnchorIds: readonly string[]): Promise<number> {
  let seeded = 0;
  if (hiddenAnchorIds.length === 0) return seeded;
  for (const deviceClass of ["desktop", "mobile"] as const) {
    const scope: Scope = { surfaceId: "dashboard", deviceClass };
    if (await latestRevision(userId, scope)) continue;
    const base = await resolvedFor(userId, scope, null);
    const draft: Draft = {
      draftId: `legacy_${deviceClass}`,
      draftRevision: 1,
      baseRevision: "default",
      scope,
      status: "ready",
      patches: [{
        patchId: `legacy_${deviceClass}`,
        patchSchemaVersion: 1,
        scope,
        baseRevision: "default",
        catalogVersion: base.workspace.catalogVersion,
        author: "user",
        provenance: {},
        intent: { kind: "reduce", status: "explicit" },
        operations: hiddenAnchorIds.map(anchorId => ({ type: "visibility" as const, operationId: `legacy_${deviceClass}_${anchorId}`, anchorId, visible: false })),
        evidence: [],
        proposedConstraints: [],
      }],
    };
    const { input, workspace } = await resolvedFor(userId, scope, draft);
    const revision = committedRevisionFrom(input);
    if (await insertSeedRevision(userId, scope, revision, descriptorFor({ ...workspace, sourceActiveRevision: revision.revisionId }, input))) seeded++;
  }
  return seeded;
}
