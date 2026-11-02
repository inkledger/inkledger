import { useCallback, useMemo } from "react";
import { TRPCClientError } from "@trpc/client";
import { trpc } from "@/lib/trpc";
import type { DiscoveryState, Draft, Scope } from "@contracts/workspace/model";
import type { StaleDraftInfo } from "@contracts/workspace/repropose";
import { whenWorkspaceIdle, workspaceInteractionEpoch, workspaceTaskActive } from "./client";

export type WorkspaceActions = ReturnType<typeof useWorkspaceActions>;

/** A draft refused because it was made on an older layout: how many of its changes can be kept, else null. */
export function staleDraftOf(error: unknown): StaleDraftInfo | null {
  if (!(error instanceof TRPCClientError)) return null;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || !("staleDraft" in data)) return null;
  const info = data.staleDraft;
  return typeof info === "object" && info !== null && "keepable" in info && typeof info.keepable === "number" ? { keepable: info.keepable } : null;
}

export function useWorkspaceActions(scope: Scope, clientInstanceId: string) {
  const utils = trpc.useUtils();
  const saveDraft = trpc.workspace.saveDraft.useMutation().mutateAsync;
  const completeDraft = trpc.workspace.completeDraft.useMutation().mutateAsync;
  const discardDraft = trpc.workspace.discardDraft.useMutation().mutateAsync;
  const reproposeDraft = trpc.workspace.reproposeDraft.useMutation().mutateAsync;
  const prepare = trpc.workspace.prepare.useMutation().mutateAsync;
  const commit = trpc.workspace.commit.useMutation().mutateAsync;
  const activate = trpc.workspace.activate.useMutation().mutateAsync;
  const acknowledge = trpc.workspace.acknowledge.useMutation().mutateAsync;
  const defer = trpc.workspace.defer.useMutation().mutateAsync;
  const reconcile = trpc.workspace.reconcile.useMutation().mutateAsync;
  const renew = trpc.workspace.renew.useMutation().mutateAsync;
  const rollback = trpc.workspace.rollback.useMutation().mutateAsync;
  const discovery = trpc.workspace.discovery.useMutation().mutateAsync;

  // A commit can make this the user's first customized scope: settings.get says which ones run live.
  const invalidate = useCallback(() => Promise.all([utils.workspace.get.invalidate({ scope, clientInstanceId }), utils.settings.get.invalidate()]).then(() => undefined), [utils, scope, clientInstanceId]);

  return useMemo(() => ({
    discardDraft: async (draftId: string) => {
      await discardDraft({ scope, draftId });
      await invalidate();
    },
    saveDraft: async (draft: Draft) => {
      const result = await saveDraft({ scope, draft });
      await invalidate();
      return result;
    },
    /** The stale draft's changes nobody touched since, as a new preview on the current layout: never applied here. */
    reproposeDraft: async (draft: Draft) => {
      const result = await reproposeDraft({ scope, draft });
      await invalidate();
      return result;
    },
    applyDraft: async (draft: Draft) => {
      try {
        if (workspaceTaskActive()) return { status: "deferred" as const };
        const interactionEpoch = workspaceInteractionEpoch();
        // A task that started (even ended) between two steps changed the page: hold back, do not swap it.
        const interrupted = () => workspaceTaskActive() || workspaceInteractionEpoch() !== interactionEpoch;
        const ready = await saveDraft({ scope, draft });
        if (ready.draft.status !== "ready") return { status: "conflict" as const, preview: ready.preview };
        if (interrupted()) return { status: "deferred" as const };
        const prepared = await prepare({
          scope,
          prepareId: `prepare_${crypto.randomUUID()}`,
          clientInstanceId,
          draftRevision: ready.draft.draftRevision,
          interactionEpoch,
        });
        if (interrupted()) return { status: "deferred" as const };
        const committed = await commit({
          scope,
          prepareId: prepared.prepareId,
          operationId: `apply_${crypto.randomUUID()}`,
          clientInstanceId,
          draftRevision: ready.draft.draftRevision,
          interactionEpoch,
        });
        if (!committed.leaseToken) {
          await invalidate();
          return { status: "committed" as const, revision: committed.revision };
        }
        let leaseToken = committed.leaseToken;
        let leaseEpoch = committed.presentation.pending?.interactionEpoch ?? interactionEpoch;
        // A task started while committing: the layout is saved (its draft with it), and shows in this tab
        // only once the task is over, through a fresh lease (§15.4: activation waits for a safe boundary).
        while (workspaceTaskActive() || workspaceInteractionEpoch() !== leaseEpoch) {
          await defer({ scope, clientInstanceId, interactionEpoch: leaseEpoch });
          await completeDraft({ scope, draftId: ready.draft.draftId, draftRevision: ready.draft.draftRevision });
          await invalidate();
          await whenWorkspaceIdle();
          leaseEpoch = workspaceInteractionEpoch();
          leaseToken = (await renew({ scope, clientInstanceId, interactionEpoch: leaseEpoch, draftRevision: ready.draft.draftRevision })).leaseToken;
        }
        const activated = await activate({ scope, clientInstanceId, interactionEpoch: leaseEpoch, leaseToken });
        await acknowledge({
          scope,
          clientInstanceId,
          activationId: activated.activationId,
          effectiveRevision: activated.presentation.pending!.descriptor.effectiveRevision,
          workspaceFingerprint: activated.presentation.pending!.descriptor.workspaceFingerprint,
          presentationEpoch: activated.presentation.pending!.presentationEpoch,
        });
        await completeDraft({ scope, draftId: ready.draft.draftId, draftRevision: ready.draft.draftRevision });
        await invalidate();
        return { status: "applied" as const, revision: committed.revision };
      } catch (error) {
        // Failed after a step the server already took (a commit, an activation): show what it holds now.
        await invalidate().catch(() => {});
        throw error;
      }
    },
    defer: async (interactionEpoch: number) => {
      const result = await defer({ scope, clientInstanceId, interactionEpoch });
      await invalidate();
      return result;
    },
    reconcile: async (input: { effectiveRevision: string; workspaceFingerprint: string; presentationEpoch: number }, draftId?: string) => {
      if (workspaceTaskActive()) return { status: "deferred" as const };
      const result = await reconcile({ scope, clientInstanceId, ...input });
      if (draftId) await completeDraft({ scope, draftId });
      await invalidate();
      return { status: "reconciled" as const, presentation: result };
    },
    renew: async (input: { interactionEpoch: number; draftRevision: number }) => {
      const result = await renew({ scope, clientInstanceId, ...input });
      await invalidate();
      return result;
    },
    markDiscovery: async (state: DiscoveryState) => {
      const result = await discovery({
        scope,
        clientInstanceId,
        seenAnchorIds: [...state.seenAnchorIds],
        placedAnchorIds: [...state.placedAnchorIds],
        dismissedAnchorIds: [...state.dismissedAnchorIds],
        seenAreaIds: [...state.seenAreaIds ?? []],
        placedAreaIds: [...state.placedAreaIds ?? []],
        dismissedAreaIds: [...state.dismissedAreaIds ?? []],
      });
      await invalidate();
      return result;
    },
    rollback: async (targetRevision: string) => {
      const result = await rollback({ scope, clientInstanceId, targetRevision });
      await invalidate();
      return result;
    },
  }), [invalidate, scope, clientInstanceId, saveDraft, reproposeDraft, completeDraft, discardDraft, prepare, commit, activate, acknowledge, defer, reconcile, renew, rollback, discovery]);
}
