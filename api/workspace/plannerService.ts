import { t } from "@contracts/i18n";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import { candidateSeeds, compareEvidence, requestOperationSeeds, type CandidateSeed, type OperationSeed } from "@contracts/workspace/planner";
import { resolve } from "@contracts/workspace/resolve";
import type { LayoutOperation, ResolvedWorkspace, Scope, SuggestionPatch } from "@contracts/workspace/model";
import { chat, ollamaRefusal } from "../ai/ollama";
import { env } from "../lib/env";
import { fingerprint } from "./crypto";
import { evidenceById, listEvidence } from "./flowStore";
import { getWorkspace } from "./service";
import { draftSchema } from "./validation";
import { plannerFeedback, suppressPlannerSuggestion } from "./plannerStore";

function operation(seed: OperationSeed): LayoutOperation {
  return { ...seed, operationId: `op_${randomUUID()}` };
}

/** The same change on the same scope: one signature, whatever new evidence suggests it again (no nagging). */
function signature(scope: Scope, operations: readonly LayoutOperation[]): string {
  return fingerprint("workspace", { scope, operations: operations.map(operation => ({ ...operation, operationId: "stable" })), catalogVersion: CATALOG_V1.catalogVersion }).value;
}

function layoutFingerprint(workspace: ResolvedWorkspace): string {
  return fingerprint("workspace", {
    ...workspace,
    sourceActiveRevision: undefined,
    placements: workspace.placements.map(placement => ({ ...placement, origin: undefined, operationId: undefined })),
  }).value;
}

async function previewPatch(userId: number, scope: Scope, patch: SuggestionPatch) {
  const current = await getWorkspace(userId, scope);
  const draft = draftSchema.parse({ draftId: current.draft?.draftId ?? `candidate_${randomUUID()}`, draftRevision: (current.draft?.draftRevision ?? 0) + 1, baseRevision: current.workspace.sourceActiveRevision, scope, patches: [...current.draft?.patches ?? [], patch], status: "ready" });
  const preview = resolve({ ...current.input, draft });
  if (preview.kind === "conflicts") throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.unresolved"), cause: preview.conflicts });
  if (layoutFingerprint(preview.workspace) === layoutFingerprint(current.draftWorkspace ?? current.workspace)) {
    throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.noChange") });
  }
  return { patch, preview: preview.workspace };
}

async function deterministicCandidates(userId: number, scope: Scope) {
  const current = await getWorkspace(userId, scope);
  const evidence = (await listEvidence(userId, scope)).find(item => item.origin === "local" && item.descriptor.effectiveRevision === current.descriptor.effectiveRevision);
  const observed = evidence?.heat.reduce((sum, point) => sum + point.activations, 0) ?? 0;
  if (!evidence || evidence.coverage.activeDays < 5 || observed < 30) return { current, evidence, seeds: [] as CandidateSeed[] };
  const seeds = candidateSeeds({ evidence, workspace: current.draftWorkspace ?? current.workspace, catalog: CATALOG_V1, draft: current.draft, effectiveRevision: current.descriptor.effectiveRevision });
  return { current, evidence, seeds };
}

const aiOutput = z.strictObject({ candidateIds: z.array(z.string().regex(/^candidate-\d+$/)).max(3) });

async function aiCandidates(userId: number, scope: Scope): Promise<CandidateSeed[] | null> {
  const { current, evidence, seeds } = await deterministicCandidates(userId, scope);
  if (!evidence || seeds.length === 0) return [];
  if (await ollamaRefusal({ url: env.ollamaUrl, allowPublic: false, simulator: env.ollamaSimulator })) return null;
  const aggregates = {
    scope,
    effectiveRevision: evidence.descriptor.effectiveRevision,
    coverage: evidence.coverage,
    heat: evidence.heat.map(({ controlId, anchorId, activations, successes, failures, exposures }) => ({ controlId, anchorId, activations, successes, failures, exposures })),
    flows: evidence.flows,
    friction: evidence.friction,
  };
  const workspace = current.draftWorkspace ?? current.workspace;
  const options = seeds.map((seed, index) => ({ id: `candidate-${index + 1}`, operation: seed.operation, reason: seed.reason, ranking: seed.ranking }));
  const byId = new Map(options.map((option, index) => [option.id, seeds[index]] as const));
  try {
    const result = await chat(aiOutput, [
      { role: "system", content: "Select and rank only the supplied candidate IDs that would most improve the observed workflow. Never invent operations or IDs. Preserve user choices and prefer meaningful changes with strong evidence and low relearning cost. Return an empty list if uncertain. No code, CSS, DOM, text generation or constraints." },
      { role: "user", content: JSON.stringify({ aggregates, candidates: options, placements: workspace.placements.map(({ anchorId, areaId, order, variant, visible, pinned }) => ({ anchorId, areaId, order, variant, visible, pinned })) }) },
    ], { timeoutMs: 10_000, numCtx: 8_192, numPredict: 256 });
    const selected: CandidateSeed[] = [];
    for (const id of result.candidateIds) {
      const seed = byId.get(id);
      if (seed && !selected.includes(seed)) selected.push(seed);
    }
    return selected;
  } catch {
    return null;
  }
}

const requestOutput = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("clarify"), question: z.string().trim().min(1).max(300) }),
  z.strictObject({
    status: z.literal("ready"),
    intent: z.strictObject({
      kind: z.enum(["prioritize", "reduce", "group", "expectHere", "keepVisible", "custom"]),
      anchorId: z.string().max(128).optional(),
      areaId: z.string().max(128).optional(),
    }),
    candidateIds: z.array(z.string().regex(/^request-\d+$/)).min(1).max(3),
    constraints: z.array(z.strictObject({
      kind: z.enum(["pin", "hide", "keepVisible", "expectHere", "doNotSuggest"]),
      anchorId: z.string().max(128),
      areaId: z.string().max(128).optional(),
    })).max(2).default([]),
  }),
]);

export async function interpretWorkspaceRequest(userId: number, scope: Scope, originalText: string) {
  const request = originalText.trim();
  if (!request || request.length > 2_000) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.workspace.requestLength") });
  if (await ollamaRefusal({ url: env.ollamaUrl, allowPublic: false, simulator: env.ollamaSimulator })) return { status: "unavailable" as const };
  const current = await getWorkspace(userId, scope);
  const workspace = current.draftWorkspace ?? current.workspace;
  // Only options that resolve and change what is on screen: a pick of a no-op or a refused one is never offered.
  const before = layoutFingerprint(workspace);
  const effective = (seed: OperationSeed) => {
    const probe: SuggestionPatch = { patchId: "probe", patchSchemaVersion: 1, scope, baseRevision: current.workspace.sourceActiveRevision, catalogVersion: current.workspace.catalogVersion, author: "AI", provenance: {}, intent: { kind: "custom", status: "proposed" }, operations: [operation(seed)], evidence: [], proposedConstraints: [] };
    const result = resolve({ ...current.input, draft: { draftId: "probe", draftRevision: 1, baseRevision: current.workspace.sourceActiveRevision, scope, patches: [...current.draft?.patches ?? [], probe], status: "ready" } });
    return result.kind === "resolved" && layoutFingerprint(result.workspace) !== before;
  };
  const options = requestOperationSeeds(workspace, CATALOG_V1).filter(effective).map((seed, index) => ({ id: `request-${index + 1}`, operation: seed }));
  const byId = new Map(options.map(option => [option.id, option.operation] as const));
  let translated: z.infer<typeof requestOutput>;
  try {
    translated = await chat(requestOutput, [
      { role: "system", content: "Translate a private layout request by selecting only supplied candidate IDs. Return ready only when target and action are unambiguous and every selected candidate matches the request; otherwise return clarify with one short question in the user's language. Never invent IDs or operations. Never repeat the original request in the output. No code, CSS, DOM, credentials, telemetry or automatic apply. Constraints are proposals only and require explicit user confirmation." },
      { role: "user", content: JSON.stringify({
        request,
        scope,
        candidates: options,
        placements: workspace.placements.map(({ anchorId, areaId, order, variant, visible, pinned }) => ({ anchorId, areaId, order, variant, visible, pinned })),
        constraints: current.constraints.map(({ kind, anchorId, areaId }) => ({ kind, anchorId, areaId })),
      }) },
    ], { timeoutMs: 10_000, numCtx: 8_192, numPredict: 512 });
  } catch {
    return { status: "unavailable" as const };
  }
  if (translated.status === "clarify") return translated;
  const seen = new Set<string>();
  const selected = translated.candidateIds.filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return byId.has(id);
  }).map(id => byId.get(id)!);
  if (selected.length === 0) return { status: "invalid" as const };
  const anchorIds = selected.flatMap(item => item.type === "reorder" ? item.anchorIds : [item.anchorId]);
  const areaIds = selected.map(item => item.type === "reorder" ? item.areaId : item.type === "move" ? item.toAreaId : null).filter(Boolean);
  // The intent and any proposed constraint must be about what was selected: the model cannot justify itself.
  if ((translated.intent.anchorId && !anchorIds.includes(translated.intent.anchorId)) || (translated.intent.areaId && !areaIds.includes(translated.intent.areaId))) return { status: "invalid" as const };
  const areaAllows = (areaId: string, anchorId: string) => CATALOG_V1.areas.some(area => area.id === areaId && area.surfaceId === scope.surfaceId && area.allowedAnchorIds.includes(anchorId));
  if (translated.constraints.some(constraint => !anchorIds.includes(constraint.anchorId) || (constraint.areaId !== undefined && !areaAllows(constraint.areaId, constraint.anchorId)))) return { status: "invalid" as const };
  const patch: SuggestionPatch = {
    patchId: `request_${randomUUID()}`,
    patchSchemaVersion: 1,
    scope,
    baseRevision: current.workspace.sourceActiveRevision,
    catalogVersion: current.workspace.catalogVersion,
    author: "AI",
    provenance: { model: env.ollamaModel, modelVersion: "local" },
    intent: { ...translated.intent, status: "proposed" },
    operations: selected.map(item => operation(item)),
    evidence: [],
    proposedConstraints: translated.constraints.map(constraint => ({ ...constraint, id: `constraint_${randomUUID()}`, status: "proposed", author: "AI", scope })),
  };
  try {
    const preview = await previewPatch(userId, scope, patch);
    return { status: "ready" as const, ...preview };
  } catch {
    return { status: "invalid" as const };
  }
}

export async function generateWorkspaceSuggestions(userId: number, scope: Scope, enrichAI = false) {
  const { current, evidence, seeds } = await deterministicCandidates(userId, scope);
  const observed = evidence?.heat.reduce((sum, point) => sum + point.activations, 0) ?? 0;
  if (!evidence || observed < 30 || evidence.coverage.activeDays < 5) {
    return { status: "insufficient-evidence" as const, required: { activeDays: 5, activations: 30 }, actual: { activeDays: evidence?.coverage.activeDays ?? 0, activations: observed }, suggestions: [] };
  }
  const ai = enrichAI ? await aiCandidates(userId, scope) : null;
  const source = [
    ...(ai ?? []).map(seed => ({ seed, author: "AI" as const })),
    ...seeds.map(seed => ({ seed, author: "deterministic" as const })),
  ];
  const feedback = await plannerFeedback(userId);
  const suggestions = [];
  const seen = new Set<string>();
  for (const { seed, author } of source) {
    const operations = [operation(seed.operation)];
    const patch: SuggestionPatch = {
      patchId: `suggestion_${randomUUID()}`,
      patchSchemaVersion: 1,
      scope,
      baseRevision: current.workspace.sourceActiveRevision,
      catalogVersion: current.workspace.catalogVersion,
      author,
      provenance: author === "AI" ? { model: env.ollamaModel, modelVersion: "local" } : {},
      intent: { kind: "prioritize", status: "proposed", anchorId: seed.anchorId },
      operations,
      evidence: [{ evidenceId: evidence.evidenceId, effectiveRevision: evidence.descriptor.effectiveRevision }],
      proposedConstraints: [],
      expectedOutcome: "Observed reduction in steps between catalogued controls; not a causal guarantee",
      suggestionSignature: signature(scope, operations),
    };
    if (patch.suggestionSignature && (feedback.suppressedSuggestionSignatures.includes(patch.suggestionSignature) || seen.has(patch.suggestionSignature))) continue;
    try {
      const preview = await previewPatch(userId, scope, patch);
      suggestions.push({ ...preview, reason: seed.reason, ranking: seed.ranking, adaptationWindowDays: 5 });
      seen.add(patch.suggestionSignature!);
    } catch {
      continue;
    }
  }
  suggestions.sort((a, b) => b.ranking.benefit.maximum - a.ranking.benefit.maximum || b.ranking.evidenceQuality - a.ranking.evidenceQuality || a.ranking.relearningCost - b.ranking.relearningCost || (a.patch.patchId < b.patch.patchId ? -1 : 1));
  const ranked = suggestions.slice(0, 3);
  return { status: "ready" as const, ai: enrichAI ? ranked.some(candidate => candidate.patch.author === "AI") ? "enriched" as const : "unavailable" as const : "not-requested" as const, evidenceId: evidence.evidenceId, suggestions: ranked };
}

export async function evaluateWorkspaceAdaptation(userId: number, scope: Scope, beforeId: string, afterId: string) {
  const before = await evidenceById(userId, beforeId, scope);
  const after = await evidenceById(userId, afterId, scope);
  if (!before || !after) throw new TRPCError({ code: "NOT_FOUND", message: t("server.workspace.evidenceGone") });
  return compareEvidence(before, after);
}

export { suppressPlannerSuggestion };
