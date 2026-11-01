import { useCallback, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import type { DiscoveryState, Draft, Scope } from "@contracts/workspace/model";
import { workspaceInteractionEpoch, workspaceTaskActive } from "./client";

export type WorkspaceActions = ReturnType<typeof useWorkspaceActions>;

export function useWorkspaceActions(scope: Scope, clientInstanceId: string) {
  const utils = trpc.useUtils();
  const saveDraft = trpc.workspace.saveDraft.useMutation().mutateAsync;
  const completeDraft = trpc.workspace.completeDraft.useMutation().mutateAsync;
  const discardDraft = trpc.workspace.discardDraft.useMutation().mutateAsync;
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
        if (interrupted()) {
          await defer({ scope, clientInstanceId, interactionEpoch: committed.presentation.pending?.interactionEpoch ?? interactionEpoch });
          await invalidate();
          return { status: "deferred" as const };
        }
        const activated = await activate({ scope, clientInstanceId, interactionEpoch, leaseToken: committed.leaseToken });
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
  }), [invalidate, scope, clientInstanceId, saveDraft, completeDraft, discardDraft, prepare, commit, activate, acknowledge, defer, reconcile, renew, rollback, discovery]);
}
