import type { FlowEvent } from "../contracts/workspace/flowMap";
import type { Scope } from "../contracts/workspace/model";

process.env.DATABASE_URL = ":memory:";
process.env.OLLAMA_SIMULATOR = "";

const { q, resetDbForTests, closeDb } = await import("../api/queries/connection");
const { aggregateEvidence, FLOW_EVENT_SCHEMA_VERSION } = await import("../contracts/workspace/flowMap");
const { getWorkspace } = await import("../api/workspace/service");
const { saveEvidence, setFlowConsent } = await import("../api/workspace/flowStore");
const { generateWorkspaceSuggestions, interpretWorkspaceRequest } = await import("../api/workspace/plannerService");
const { ollamaRefusal } = await import("../api/ai/ollama");
const { env } = await import("../api/lib/env");

const scope: Scope = { surfaceId: "dashboard", deviceClass: "desktop" };
/** An operation as the model sees it: its id is ours, not part of what it chose. */
const withoutOperationId = <T extends { operationId: string }>(operation: T): Omit<T, "operationId"> => {
  const copy: Partial<T> = { ...operation };
  delete copy.operationId;
  return copy as Omit<T, "operationId">;
};

try {
  const refusal = await ollamaRefusal({ url: env.ollamaUrl, allowPublic: false, simulator: null });
  if (refusal) throw new Error(`A local Ollama instance is required: ${refusal}`);
  await resetDbForTests();
  await q("INSERT INTO users(display_name,created_at) VALUES (?,?)", "Synthetic planner evaluation", Date.now());
  await setFlowConsent(1, true);
  const current = await getWorkspace(1, scope, "evaluation-client");
  const events: FlowEvent[] = Array.from({ length: 15 }, (_, index) => {
    const day = index % 5;
    const cycle = Math.floor(index / 5);
    return [
      { id: `from-${index}`, sequence: cycle * 3 + 1, controlId: "dashboard.tasks.openBoard", anchorId: "dashboard.tasks" },
      { id: `to-${index}`, sequence: cycle * 3 + 2, controlId: "dashboard.timeline.gap", anchorId: "dashboard.timeline" },
      { id: `success-${index}`, sequence: cycle * 3 + 3, controlId: "dashboard.timeline.gap", anchorId: "dashboard.timeline", kind: "action.succeeded" as const },
    ].map((item): FlowEvent => ({
      eventSchemaVersion: FLOW_EVENT_SCHEMA_VERSION,
      kind: "control.activate",
      scope,
      semanticRevision: 1,
      descriptor: current.descriptor,
      clientInstanceId: "evaluation-client",
      presentationEpoch: 1,
      sessionId: `evaluation-session-${index}`,
      occurredAt: Date.now() - day * 86_400_000,
      modality: "keyboard",
      ...item,
    }));
  }).flat();
  const evidence = aggregateEvidence(events, current.descriptor, scope, "evaluation-evidence", 0, { "dashboard.tasks": "dashboard.primary", "dashboard.timeline": "dashboard.primary" });
  await saveEvidence(1, evidence);

  const startedAt = Date.now();
  const suggestions = await generateWorkspaceSuggestions(1, scope, true);
  if (suggestions.status !== "ready" || suggestions.ai !== "enriched") throw new Error(`The model did not select an admissible candidate: ${JSON.stringify(suggestions)}`);
  const suggestionSummary = suggestions.suggestions.map(item => ({ author: item.patch.author, operations: item.patch.operations.map(withoutOperationId) }));

  const requestStartedAt = Date.now();
  const ready = await interpretWorkspaceRequest(1, scope, "Make statistics more prominent");
  if (ready.status !== "ready") throw new Error(`The clear request was not translated into an effective preview: ${ready.status}`);
  if (JSON.stringify(ready).includes("Make statistics more prominent")) throw new Error("The original request leaked into the candidate");
  const ambiguous = await interpretWorkspaceRequest(1, scope, "Make it better");
  if (ambiguous.status !== "clarify") throw new Error(`The ambiguous request was not clarified: ${ambiguous.status}`);

  const [{ count }] = await q<{ count: number }>("SELECT count(*)::int AS count FROM workspace_revisions");
  if (count !== 0) throw new Error("The evaluation committed a layout revision");
  console.log(JSON.stringify({
    model: env.ollamaModel,
    fixture: "synthetic-in-memory",
    suggestionLatencyMs: Date.now() - startedAt - (Date.now() - requestStartedAt),
    requestLatencyMs: Date.now() - requestStartedAt,
    suggestions: suggestionSummary,
    clearRequest: { status: ready.status, operations: ready.patch.operations.map(withoutOperationId) },
    ambiguousRequest: ambiguous,
    committedRevisions: count,
  }, null, 2));
} finally {
  await closeDb();
}
