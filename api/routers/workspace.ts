import { z } from "zod";
import { createRouter, protectedProcedure } from "../middleware";
import { guard } from "../workspace/limits";
import { draftSchema, workspaceInputSchemas } from "../workspace/validation";
import {
  activateWorkspace,
  acknowledgeWorkspace,
  commitWorkspace,
  completeWorkspaceDraft,
  deferWorkspace,
  discardWorkspaceDraft,
  getWorkspace,
  prepareWorkspace,
  reconcileWorkspace,
  renewWorkspaceActivationLease,
  rollbackWorkspace,
  markWorkspaceDiscovery,
  saveWorkspaceDraft,
} from "../workspace/service";

const scope = workspaceInputSchemas.scope;
const clientInstanceId = z.string().min(1).max(128);
const interactionEpoch = z.number().int().nonnegative();
const draftRevision = z.number().int().positive();
const prepareInput = z.strictObject({
  scope,
  prepareId: z.string().min(1).max(128),
  clientInstanceId,
  draftRevision,
  interactionEpoch,
});
const commitInput = prepareInput.extend({ operationId: z.string().min(1).max(128) });
const activationInput = z.strictObject({
  scope,
  clientInstanceId,
  interactionEpoch,
  leaseToken: z.string().min(1).max(256),
});
const renewInput = z.strictObject({ scope, clientInstanceId, interactionEpoch, draftRevision });
const presentationInput = z.strictObject({
  scope,
  clientInstanceId,
  effectiveRevision: z.string().min(1).max(256),
  workspaceFingerprint: z.string().min(1).max(256),
  presentationEpoch: z.number().int().positive(),
});
const acknowledgeInput = presentationInput.extend({ activationId: z.string().min(1).max(256) });

const discoveryInput = z.strictObject({
  scope,
  clientInstanceId: clientInstanceId.optional(),
  seenAnchorIds: z.array(z.string().min(1).max(128)).max(64),
  placedAnchorIds: z.array(z.string().min(1).max(128)).max(64),
  dismissedAnchorIds: z.array(z.string().min(1).max(128)).max(64),
  seenAreaIds: z.array(z.string().min(1).max(128)).max(64).optional(),
  placedAreaIds: z.array(z.string().min(1).max(128)).max(64).optional(),
  dismissedAreaIds: z.array(z.string().min(1).max(128)).max(64).optional(),
});

export const workspaceRouter = createRouter({
  get: protectedProcedure
    .input(z.strictObject({ scope, clientInstanceId: clientInstanceId.optional() }))
    .query(({ ctx, input }) => guard(() => getWorkspace(ctx.user.id, input.scope, input.clientInstanceId))),

  discovery: protectedProcedure
    .input(discoveryInput)
    .mutation(({ ctx, input }) => guard(() => markWorkspaceDiscovery(ctx.user.id, input.scope, input, input.clientInstanceId))),

  saveDraft: protectedProcedure
    .input(z.strictObject({ scope, draft: draftSchema }))
    .mutation(({ ctx, input }) => guard(() => saveWorkspaceDraft(ctx.user.id, input.scope, input.draft))),

  completeDraft: protectedProcedure
    .input(z.strictObject({ scope, draftId: z.string().min(1).max(128) }))
    .mutation(({ ctx, input }) => guard(() => completeWorkspaceDraft(ctx.user.id, input.scope, input.draftId))),

  discardDraft: protectedProcedure
    .input(z.strictObject({ scope, draftId: z.string().min(1).max(128) }))
    .mutation(({ ctx, input }) => guard(() => discardWorkspaceDraft(ctx.user.id, input.scope, input.draftId))),

  prepare: protectedProcedure
    .input(prepareInput)
    .mutation(({ ctx, input }) => guard(() => prepareWorkspace({ userId: ctx.user.id, ...input }))),

  commit: protectedProcedure
    .input(commitInput)
    .mutation(({ ctx, input }) => guard(() => commitWorkspace({ userId: ctx.user.id, ...input }))),

  activate: protectedProcedure
    .input(activationInput)
    .mutation(({ ctx, input }) => guard(() => activateWorkspace({ userId: ctx.user.id, ...input }))),

  renew: protectedProcedure
    .input(renewInput)
    .mutation(({ ctx, input }) => guard(() => renewWorkspaceActivationLease({ userId: ctx.user.id, ...input }))),

  acknowledge: protectedProcedure
    .input(acknowledgeInput)
    .mutation(({ ctx, input }) => guard(() => acknowledgeWorkspace({ userId: ctx.user.id, ...input }))),

  reconcile: protectedProcedure
    .input(presentationInput)
    .mutation(({ ctx, input }) => guard(() => reconcileWorkspace({ userId: ctx.user.id, ...input }))),

  defer: protectedProcedure
    .input(z.strictObject({ scope, clientInstanceId, interactionEpoch }))
    .mutation(({ ctx, input }) => guard(() => deferWorkspace(ctx.user.id, input.scope, input.clientInstanceId, input.interactionEpoch))),

  rollback: protectedProcedure
    .input(z.strictObject({ scope, clientInstanceId, targetRevision: z.string().min(1).max(256) }))
    .mutation(({ ctx, input }) => guard(() => rollbackWorkspace(ctx.user.id, input.scope, input.clientInstanceId, input.targetRevision))),
});
