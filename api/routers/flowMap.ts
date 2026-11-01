import { z } from "zod";
import { createRouter, protectedProcedure } from "../middleware";
import { workspaceInputSchemas } from "../workspace/validation";
import { flowEventBatchSchema } from "../workspace/flowValidation";
import { throttle, WORKSPACE_LIMITS } from "../workspace/limits";
import { deleteFlowData, exportFlowMap, flowMapOverview, generateFlowEvidence, getFlowSettings, importFlowMap, ingestFlowEvents, reviewExpectation, setFlowConsent } from "../workspace/flowService";

const scope = workspaceInputSchemas.scope;

export const flowMapRouter = createRouter({
  settings: protectedProcedure.query(({ ctx }) => getFlowSettings(ctx.user.id)),
  get: protectedProcedure.input(z.strictObject({ scope })).query(({ ctx, input }) => flowMapOverview(ctx.user.id, input.scope)),
  consent: protectedProcedure.input(z.strictObject({ enabled: z.boolean() })).mutation(({ ctx, input }) => setFlowConsent(ctx.user.id, input.enabled)),
  ingest: protectedProcedure.input(flowEventBatchSchema).mutation(({ ctx, input }) => {
    throttle(WORKSPACE_LIMITS.ingest, ctx.user.id);
    return ingestFlowEvents(ctx.user.id, input.events);
  }),
  aggregate: protectedProcedure.input(z.strictObject({ scope, effectiveRevision: z.string().min(1).max(256).optional() })).mutation(({ ctx, input }) => {
    throttle(WORKSPACE_LIMITS.analysis, ctx.user.id);
    return generateFlowEvidence(ctx.user.id, input.scope, input.effectiveRevision);
  }),
  export: protectedProcedure.input(z.strictObject({ scope, evidenceId: z.string().min(1).max(128), view: z.enum(["heat", "flow", "friction", "expectation"]) })).mutation(({ ctx, input }) => {
    throttle(WORKSPACE_LIMITS.analysis, ctx.user.id);
    return exportFlowMap(ctx.user.id, input.scope, input.evidenceId, input.view);
  }),
  import: protectedProcedure.input(z.strictObject({ contents: z.string().max(512_000) })).mutation(({ ctx, input }) => {
    throttle(WORKSPACE_LIMITS.imports, ctx.user.id);
    return importFlowMap(ctx.user.id, input.contents);
  }),
  feedback: protectedProcedure.input(z.strictObject({ scope, expectationId: z.string().min(1).max(400), status: z.enum(["confirmed", "rejected", "unconfirmed"]) })).mutation(({ ctx, input }) => reviewExpectation(ctx.user.id, input.scope, input.expectationId, input.status)),
  delete: protectedProcedure.mutation(({ ctx }) => deleteFlowData(ctx.user.id).then(() => ({ deleted: true }))),
});
