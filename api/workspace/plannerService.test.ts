import { beforeEach, describe, expect, it, vi } from "vitest";
import { q, resetDbForTests } from "../queries/connection";
import { aggregateEvidence, FLOW_EVENT_SCHEMA_VERSION, type FlowEvent } from "@contracts/workspace/flowMap";
import type { Scope } from "@contracts/workspace/model";
import { getWorkspace, saveWorkspaceDraft } from "./service";
import { generateFlowEvidence } from "./flowService";
import { saveEvidence, setFlowConsent } from "./flowStore";
import { generateWorkspaceSuggestions, interpretWorkspaceRequest, rankSuggestions, suppressPlannerSuggestion } from "./plannerService";
import { chat } from "../ai/ollama";

// A local model "configured" whatever this machine's .env says (CI has none): only `chat` answers vary.
vi.mock("../ai/ollama", async importOriginal => ({ ...await importOriginal<typeof import("../ai/ollama")>(), chat: vi.fn(), ollamaRefusal: vi.fn(async () => null) }));

const scope: Scope = { surfaceId: "dashboard", deviceClass: "desktop" };

describe("workspace planner service", () => {
  beforeEach(async () => {
    await resetDbForTests();
    await q("INSERT INTO users(display_name,created_at) VALUES (?,?)", "First", Date.now());
    vi.mocked(chat).mockReset();
    vi.mocked(chat).mockRejectedValue(new Error("local model unavailable"));
  });

  async function seedEvidence(evidenceId = "evidence-current") {
    await setFlowConsent(1, true);
    const current = await getWorkspace(1, scope, "tab-a");
    const events: FlowEvent[] = Array.from({ length: 15 }, (_, index) => {
      const day = index % 5;
      const cycle = Math.floor(index / 5);
      return [
      { id: `from-${index}`, sequence: cycle * 3 + 1, controlId: "dashboard.tasks.openBoard", anchorId: "dashboard.tasks" },
      { id: `to-${index}`, sequence: cycle * 3 + 2, controlId: "dashboard.timeline.gap", anchorId: "dashboard.timeline" },
      { id: `success-${index}`, sequence: cycle * 3 + 3, controlId: "dashboard.timeline.gap", anchorId: "dashboard.timeline", kind: "action.succeeded" as const },
    ].map((item): FlowEvent => ({
      eventSchemaVersion: FLOW_EVENT_SCHEMA_VERSION,
      kind: "control.activate" as const,
      scope,
      semanticRevision: 1,
      descriptor: current.descriptor,
      clientInstanceId: "tab-a",
      presentationEpoch: 1,
      // One session per tasks → timeline sequence: no reverse edge from one to the next.
      sessionId: `session-${index}`,
      occurredAt: Date.now() - day * 86_400_000,
      modality: "keyboard" as const,
      ...item,
    }));
    }).flat();
    const evidence = aggregateEvidence(events, current.descriptor, scope, evidenceId, 1, { "dashboard.tasks": "dashboard.primary", "dashboard.timeline": "dashboard.primary" });
    await saveEvidence(1, evidence);
  }

  it("returns explainable candidates and persists suppression by signature", async () => {
    await seedEvidence();
    const result = await generateWorkspaceSuggestions(1, scope);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].patch.author).toBe("deterministic");
    expect(result.suggestions[0].patch.proposedConstraints).toEqual([]);
    expect(result.suggestions[0].ranking.crossDeviceImpact).toBe("none");
    await suppressPlannerSuggestion(1, result.suggestions[0].patch.suggestionSignature!);
    const suppressed = await generateWorkspaceSuggestions(1, scope);
    expect(suppressed.status).toBe("ready");
    if (suppressed.status === "ready") expect(suppressed.suggestions).toEqual([]);
    // New evidence for the same change does not bring a dismissed suggestion back.
    await seedEvidence("evidence-later");
    const later = await generateWorkspaceSuggestions(1, scope);
    expect(later.status).toBe("ready");
    expect(later.suggestions.map(item => item.patch.suggestionSignature)).not.toContain(result.suggestions[0].patch.suggestionSignature);
    expect((await getWorkspace(1, scope)).committedRevision).toBeNull();
  });

  it("composes candidate previews with the existing manual draft", async () => {
    await seedEvidence();
    await saveWorkspaceDraft(1, scope, {
      draftId: "manual-before-suggestion",
      draftRevision: 1,
      baseRevision: "default",
      scope,
      status: "ready",
      patches: [{
        patchId: "manual-stats",
        patchSchemaVersion: 1,
        scope,
        baseRevision: "default",
        catalogVersion: "1.0.0",
        author: "user",
        provenance: {},
        intent: { kind: "reduce", status: "explicit", anchorId: "dashboard.stats" },
        operations: [{ type: "visibility", operationId: "hide-stats", anchorId: "dashboard.stats", visible: false }],
        evidence: [],
        proposedConstraints: [],
      }],
    });
    const result = await generateWorkspaceSuggestions(1, scope);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].preview.placements.find(placement => placement.anchorId === "dashboard.stats")?.visible).toBe(false);
  });

  it("keeps deterministic suggestions when local AI is unavailable", async () => {
    await seedEvidence();
    const result = await generateWorkspaceSuggestions(1, scope, true);
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.ai).toBe("unavailable");
      expect(result.suggestions.length).toBeGreaterThan(0);
    }
    expect((await getWorkspace(1, scope)).committedRevision).toBeNull();
  });

  it("ignores an empty AI selection instead of replacing an effective deterministic candidate", async () => {
    await seedEvidence();
    vi.mocked(chat).mockResolvedValue({ candidateIds: [] });
    const result = await generateWorkspaceSuggestions(1, scope, true);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // The model answered "nothing to add": not the same as a model that did not answer.
    expect(result.ai).toBe("none");
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].patch.author).toBe("deterministic");
    expect(result.suggestions[0].patch.operations[0]).toMatchObject({ type: "reorder", anchorIds: ["dashboard.summary", "dashboard.tasks", "dashboard.timeline", "dashboard.activity", "dashboard.recap"] });
    expect((await getWorkspace(1, scope)).committedRevision).toBeNull();
  });

  it("ranks grounded AI candidates without duplicating deterministic operations", async () => {
    await seedEvidence();
    vi.mocked(chat).mockResolvedValue({ candidateIds: ["candidate-1"] });
    const result = await generateWorkspaceSuggestions(1, scope, true);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.ai).toBe("enriched");
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].patch.author).toBe("AI");
    expect(result.suggestions[0].patch.operations[0]).toMatchObject({ type: "reorder", anchorIds: ["dashboard.summary", "dashboard.tasks", "dashboard.timeline", "dashboard.activity", "dashboard.recap"] });
    expect(result.suggestions[0].preview.placements.filter(placement => placement.areaId === "dashboard.primary").map(placement => placement.anchorId)).toEqual(["dashboard.summary", "dashboard.tasks", "dashboard.timeline", "dashboard.activity", "dashboard.recap"]);
    expect((await getWorkspace(1, scope)).committedRevision).toBeNull();
  });

  it("ignores unknown and repeated AI candidate IDs", async () => {
    await seedEvidence();
    vi.mocked(chat).mockResolvedValue({ candidateIds: ["not-real", "candidate-1", "candidate-1"] });
    const result = await generateWorkspaceSuggestions(1, scope, true);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.ai).toBe("enriched");
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].patch.author).toBe("AI");
    expect(new Set(result.suggestions.map(candidate => candidate.patch.suggestionSignature)).size).toBe(1);
    expect((await getWorkspace(1, scope)).committedRevision).toBeNull();
  });

  /** The id the server gives an option this time (ids are positions in the list it sends the model). */
  async function requestId(wanted: Record<string, unknown>): Promise<string> {
    let id = "request-0";
    vi.mocked(chat).mockImplementationOnce(async (_schema, messages) => {
      const sent = JSON.parse(messages[1].content) as { candidates: { id: string; operation: Record<string, unknown> }[] };
      id = sent.candidates.find(candidate => Object.entries(wanted).every(([key, value]) => candidate.operation[key] === value))?.id ?? "request-0";
      return { status: "clarify", question: "?" };
    });
    await interpretWorkspaceRequest(1, scope, "probe");
    return id;
  }

  it("translates a private request into a non-authoritative preview without persisting the text", async () => {
    const id = await requestId({ type: "variant", anchorId: "dashboard.stats", variant: "expanded" });
    expect(id).not.toBe("request-0");
    vi.mocked(chat).mockResolvedValue({ status: "ready", intent: { kind: "prioritize", anchorId: "dashboard.stats" }, candidateIds: [id], constraints: [{ kind: "keepVisible", anchorId: "dashboard.stats" }] });
    const originalText = "Make the statistics more prominent and keep them visible";
    const result = await interpretWorkspaceRequest(1, scope, originalText);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.patch).toMatchObject({ author: "AI", intent: { status: "proposed" }, proposedConstraints: [{ status: "proposed", author: "AI", kind: "keepVisible" }] });
    expect(result.preview.placements.find(placement => placement.anchorId === "dashboard.stats")?.variant).toBe("expanded");
    expect(JSON.stringify(result)).not.toContain(originalText);
    expect((await getWorkspace(1, scope)).committedRevision).toBeNull();
    expect((await q("SELECT patches FROM workspace_drafts")).length).toBe(0);
  });

  it("offers the model only distinct options that change the layout and leave pinned anchors alone", async () => {
    let sent: { candidates: { id: string; operation: { type: string; anchorId?: string; anchorIds?: string[] } }[] } = { candidates: [] };
    vi.mocked(chat).mockImplementationOnce(async (_schema, messages) => {
      sent = JSON.parse(messages[1].content) as typeof sent;
      return { status: "clarify", question: "?" };
    });
    await interpretWorkspaceRequest(1, scope, "anything");
    const keys = sent.candidates.map(candidate => JSON.stringify(candidate.operation));
    expect(new Set(keys).size).toBe(keys.length);
    expect(sent.candidates.some(candidate => candidate.operation.anchorId === "dashboard.headerTimer" || candidate.operation.anchorId === "dashboard.period")).toBe(false);
  });

  it("asks for clarification without inventing a patch for an ambiguous request", async () => {
    vi.mocked(chat).mockResolvedValue({ status: "clarify", question: "Which section should be more prominent?" });
    const result = await interpretWorkspaceRequest(1, scope, "Make it more prominent");
    expect(result).toEqual({ status: "clarify", question: "Which section should be more prominent?" });
    expect((await getWorkspace(1, scope)).committedRevision).toBeNull();
    expect((await q("SELECT patches FROM workspace_drafts")).length).toBe(0);
  });

  it("rejects a semantically invalid request without applying it", async () => {
    const id = await requestId({ type: "variant", anchorId: "dashboard.stats", variant: "expanded" });
    for (const output of [
      { status: "ready", intent: { kind: "prioritize" }, candidateIds: ["request-99999"], constraints: [] },
      { status: "ready", intent: { kind: "prioritize", anchorId: "dashboard.tasks" }, candidateIds: [id], constraints: [] },
      { status: "ready", intent: { kind: "group", areaId: "dashboard.primary" }, candidateIds: [id], constraints: [{ kind: "expectHere", anchorId: "dashboard.stats", areaId: "dashboard.primary" }] },
      { status: "ready", intent: { kind: "prioritize", anchorId: "dashboard.stats" }, candidateIds: [id], constraints: [{ kind: "pin", anchorId: "dashboard.activity" }] },
    ]) {
      vi.mocked(chat).mockResolvedValueOnce(output);
      expect((await interpretWorkspaceRequest(1, scope, "Move statistics somewhere unknown")).status, JSON.stringify(output)).toBe("invalid");
    }
    expect((await getWorkspace(1, scope)).committedRevision).toBeNull();
  });

  it("keeps manual editing available when request translation is unavailable", async () => {
    const result = await interpretWorkspaceRequest(1, scope, "Make statistics more prominent");
    expect(result).toEqual({ status: "unavailable" });
    expect((await getWorkspace(1, scope)).committedRevision).toBeNull();
  });

  it("explains insufficient evidence instead of inventing recommendations", async () => {
    await setFlowConsent(1, true);
    const empty = await generateFlowEvidence(1, scope);
    expect(empty.heat).toEqual([]);
    const result = await generateWorkspaceSuggestions(1, scope);
    expect(result).toMatchObject({ status: "insufficient-evidence", actual: { activeDays: 0, activations: 0 }, suggestions: [] });
  });

  it("keeps the model's own order among its picks, and breaks ties the same way every time", () => {
    const item = (author: "AI" | "deterministic", signature: string, benefit: number) => ({ patch: { author, suggestionSignature: signature }, ranking: { benefit: { maximum: benefit }, evidenceQuality: 1, relearningCost: 1 } });
    const list = [item("AI", "s-ai-first", 0.1), item("AI", "s-ai-second", 0.9), item("deterministic", "s-b", 0.5), item("deterministic", "s-a", 0.5)];
    expect(rankSuggestions(list).map(entry => entry.patch.suggestionSignature)).toEqual(["s-ai-first", "s-ai-second", "s-a", "s-b"]);
    expect(rankSuggestions([...list].reverse().filter(entry => entry.patch.author === "deterministic")).map(entry => entry.patch.suggestionSignature)).toEqual(["s-a", "s-b"]);
  });

  it("calls a ready answer that picks nothing invalid, not unavailable", async () => {
    vi.mocked(chat).mockImplementation(async (schema: { parse: (value: unknown) => unknown }) => schema.parse({ status: "ready", intent: { kind: "custom" }, candidateIds: [], constraints: [] }));
    expect(await interpretWorkspaceRequest(1, scope, "move the stats")).toEqual({ status: "invalid" });
  });
});
