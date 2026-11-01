import { z } from "zod";
import { createRouter, protectedProcedure } from "../middleware";
import { workspaceInputSchemas } from "../workspace/validation";
import { guard, throttle, WORKSPACE_LIMITS } from "../workspace/limits";
import { evaluateWorkspaceAdaptation, generateWorkspaceSuggestions, interpretWorkspaceRequest, suppressPlannerSuggestion } from "../workspace/plannerService";
import { confirmImportedConstraint, exportWorkspace, importWorkspace } from "../workspace/portability";

const scope = workspaceInputSchemas.scope;

export const plannerRouter = createRouter({
  interpret: protectedProcedure.input(z.strictObject({ scope, originalText: z.string().trim().min(1).max(2_000) })).mutation(({ ctx, input }) => {
    throttle(WORKSPACE_LIMITS.model, ctx.user.id);
    return guard(() => interpretWorkspaceRequest(ctx.user.id, input.scope, input.originalText));
  }),
  suggest: protectedProcedure.input(z.strictObject({ scope, enrichAI: z.boolean().default(false) })).mutation(({ ctx, input }) => {
    throttle(WORKSPACE_LIMITS.analysis, ctx.user.id);
    if (input.enrichAI) throttle(WORKSPACE_LIMITS.model, ctx.user.id);
    return guard(() => generateWorkspaceSuggestions(ctx.user.id, input.scope, input.enrichAI));
  }),
  suppress: protectedProcedure.input(z.strictObject({ signature: z.string().regex(/^[0-9a-f]{64}$/) })).mutation(({ ctx, input }) => suppressPlannerSuggestion(ctx.user.id, input.signature).then(() => ({ suppressed: true }))),
  evaluate: protectedProcedure.input(z.strictObject({ scope, beforeEvidenceId: z.string().min(1).max(128), afterEvidenceId: z.string().min(1).max(128) })).query(({ ctx, input }) => evaluateWorkspaceAdaptation(ctx.user.id, input.scope, input.beforeEvidenceId, input.afterEvidenceId)),
  export: protectedProcedure.input(z.strictObject({ scope })).mutation(({ ctx, input }) => exportWorkspace(ctx.user.id, input.scope)),
  import: protectedProcedure.input(z.strictObject({ scope, contents: z.string().max(512_000) })).mutation(({ ctx, input }) => {
    throttle(WORKSPACE_LIMITS.imports, ctx.user.id);
    return guard(() => importWorkspace(ctx.user.id, input.scope, input.contents));
  }),
  confirmConstraint: protectedProcedure.input(z.strictObject({ scope, patchId: z.string().min(1).max(128), constraintId: z.string().min(1).max(128) })).mutation(({ ctx, input }) => guard(() => confirmImportedConstraint(ctx.user.id, input.scope, input.patchId, input.constraintId))),
});
