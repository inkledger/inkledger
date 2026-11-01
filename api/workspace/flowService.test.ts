import { beforeEach, describe, expect, it } from "vitest";
import { q, resetDbForTests } from "../queries/connection";
import { FLOW_EVENT_SCHEMA_VERSION, type FlowEvent } from "@contracts/workspace/flowMap";
import type { Scope } from "@contracts/workspace/model";
import { getWorkspace } from "./service";
import { purgeWorkspace } from "./purge";
import { exportFlowMap, flowMapChecksum, flowMapOverview, generateFlowEvidence, importFlowMap, ingestFlowEvents, reviewExpectation, setFlowConsent, deleteFlowData, snapshotFlowEvidence } from "./flowService";

const scope: Scope = { surfaceId: "dashboard", deviceClass: "desktop" };
let userId = 0;
let descriptor: Awaited<ReturnType<typeof getWorkspace>>["descriptor"];

async function user(name: string): Promise<number> {
  const [row] = await q<{ id: number }>("INSERT INTO users(display_name, created_at) VALUES (?, ?) RETURNING id", name, Date.now());
  return row.id;
}

function event(overrides: Partial<FlowEvent> = {}): FlowEvent {
  return {
    eventSchemaVersion: FLOW_EVENT_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    kind: "control.activate",
    scope,
    controlId: "dashboard.customize.open",
    anchorId: "dashboard.customize",
    semanticRevision: 1,
    descriptor,
    clientInstanceId: "tab-a",
    presentationEpoch: 1,
    sessionId: "session-123456",
    sequence: 1,
    occurredAt: Date.now(),
    modality: "pointer",
    cell: { x: 2, y: 4 },
    ...overrides,
  };
}

describe("FlowMap service", () => {
  beforeEach(async () => {
    await resetDbForTests();
    userId = await user("First");
    descriptor = (await getWorkspace(userId, scope, "tab-a")).descriptor;
  });

  it("does not collect before opt-in and accepts only attributed, catalogued events", async () => {
    const item = event();
    expect(await ingestFlowEvents(userId, [item])).toEqual({ received: 0, isolated: 1 });
    await setFlowConsent(userId, true);
    const stale = event({ id: "stale", presentationEpoch: 99 });
    const unknown = event({ id: "unknown", controlId: "dashboard.not-a-control" });
    const expired = event({ id: "expired", occurredAt: Date.now() - 31 * 86_400_000 });
    const sensitive = event({ id: "sensitive", controlId: "dashboard.quickLog.input", anchorId: "dashboard.quick-log" });
    expect(await ingestFlowEvents(userId, [item, item, stale, unknown, expired, sensitive])).toEqual({ received: 2, stored: 1, isolated: 4 });
    // An exposure or discovery mark names a block, never a control: a forged control id would make junk flows.
    const exposure = event({ id: "exposure-forged", kind: "anchor.exposure", controlId: "made.up", cell: undefined });
    const discovery = event({ id: "discovery-forged", kind: "discovery.seen", controlId: undefined, destinationControlId: "dashboard.customize.open", cell: undefined });
    expect(await ingestFlowEvents(userId, [exposure, discovery])).toEqual({ received: 0, stored: 0, isolated: 2 });
    const shellScope: Scope = { surfaceId: "shell-desktop", deviceClass: "desktop" };
    await getWorkspace(userId, shellScope, "tab-a");
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM workspace_presentations WHERE user_id = ? AND client_instance_id = 'tab-a'", userId))[0].n).toBe(2);
  });

  it("aggregates, exports and imports without sharing raw events or creating constraints", async () => {
    await setFlowConsent(userId, true);
    const events = Array.from({ length: 5 }, (_, day) => [
      event({ id: `from-${day}`, occurredAt: Date.now() - day * 86_400_000, sessionId: `session-${day}` }),
      event({ id: `exposure-${day}`, kind: "anchor.exposure" as const, controlId: undefined, anchorId: "dashboard.customize", modality: "unknown" as const, cell: undefined, occurredAt: Date.now() - day * 86_400_000, sessionId: `session-${day}`, sequence: 2 }),
      event({ id: `to-${day}`, controlId: "dashboard.logTime", anchorId: "dashboard.quickActions", occurredAt: Date.now() - day * 86_400_000, sessionId: `session-${day}`, sequence: 3 }),
      event({ id: `back-${day}`, occurredAt: Date.now() - day * 86_400_000, sessionId: `session-${day}`, sequence: 4 }),
      event({ id: `next-${day}`, controlId: "dashboard.logTime", anchorId: "dashboard.quickActions", occurredAt: Date.now() - day * 86_400_000, sessionId: `session-${day}`, sequence: 5 }),
      event({ id: `last-${day}`, occurredAt: Date.now() - day * 86_400_000, sessionId: `session-${day}`, sequence: 6 }),
      event({ id: `to-final-${day}`, controlId: "dashboard.logTime", anchorId: "dashboard.quickActions", occurredAt: Date.now() - day * 86_400_000, sessionId: `session-${day}`, sequence: 7 }),
      event({ id: `success-${day}`, kind: "action.succeeded" as const, controlId: "dashboard.logTime", anchorId: "dashboard.quickActions", occurredAt: Date.now() - day * 86_400_000, sessionId: `session-${day}`, sequence: 8 }),
    ]).flat();
    await ingestFlowEvents(userId, events);
    const evidence = await generateFlowEvidence(userId, scope);
    expect(evidence.coverage.activeDays).toBe(5);
    expect(evidence.expectations[0].state).toBe("unconfirmed");
    expect(await reviewExpectation(userId, scope, evidence.expectations[0].id, "confirmed")).toEqual({ expectationId: evidence.expectations[0].id, status: "confirmed", constraintCreated: false });
    const exported = await exportFlowMap(userId, scope, evidence.evidenceId, "heat");
    expect(exported.filename).toMatch(/\.flowmap$/);
    expect(exported.contents).not.toContain("session-123456");
    expect(exported.contents).not.toContain('"events"');
    expect(exported.contents).toContain('"effectiveRevision"');
    expect(exported.contents).not.toContain("<script");
    const imported = await importFlowMap(userId, exported.contents);
    expect(imported.origin).toBe("import");
    const overview = await flowMapOverview(userId, scope);
    expect(overview.imports).toHaveLength(1);
    expect(overview.evidence.every(item => item.origin === "local")).toBe(true);
    expect(overview.evidence.find(item => item.evidenceId === evidence.evidenceId)?.expectations[0].state).toBe("confirmed");
    expect(JSON.parse(exported.contents).evidence.expectations[0].state).toBe("confirmed");
    const document = JSON.parse(exported.contents) as Record<string, unknown>;
    document.svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
    const { checksum, ...body } = document;
    document.checksum = flowMapChecksum(body);
    expect(checksum).not.toBe(document.checksum);
    await expect(importFlowMap(userId, JSON.stringify(document))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A harmless picture with a valid checksum: taken, but drawn again from the numbers, never kept as sent.
    document.svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>private</text></svg>";
    document.checksum = flowMapChecksum({ ...document, checksum: undefined });
    const redrawn = await importFlowMap(userId, JSON.stringify(document));
    expect(redrawn.document.svg).not.toContain("private");
    // The same picture with the checksum of another body is refused as a damaged file.
    document.checksum = checksum;
    await expect(importFlowMap(userId, JSON.stringify(document))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("purges past retention for every user, also once FlowMap is turned off", async () => {
    await setFlowConsent(userId, true);
    const day = 86_400_000;
    await ingestFlowEvents(userId, [event({ id: "old", occurredAt: Date.now() - 20 * day }), event({ id: "new" })]);
    await setFlowConsent(userId, false);
    await purgeWorkspace(Date.now() + 15 * day);
    expect(await q("SELECT id FROM workspace_flow_events ORDER BY id")).toEqual([{ id: "new" }]);
    await purgeWorkspace(Date.now() + 31 * day);
    expect(await q("SELECT id FROM workspace_flow_events")).toEqual([]);
  });

  it("refuses expectation feedback once collection is off, instead of answering as if saved", async () => {
    await setFlowConsent(userId, true);
    await ingestFlowEvents(userId, [event()]);
    const { saveEvidence } = await import("./flowStore");
    const evidence = await generateFlowEvidence(userId, scope);
    await saveEvidence(userId, { ...evidence, evidenceId: "evidence-gap", expectations: [{ id: "gap-1", pattern: "placement", areaId: "dashboard.header", occurrences: 3, coverage: 0.5, confidence: 0.5, state: "unconfirmed" }] });
    await setFlowConsent(userId, false);
    await expect(reviewExpectation(userId, scope, "gap-1", "confirmed")).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("deletes raw and derived data independently for each user and disables collection", async () => {
    const second = await user("Second");
    await setFlowConsent(userId, true);
    await setFlowConsent(second, true);
    await ingestFlowEvents(userId, [event()]);
    const evidence = await generateFlowEvidence(userId, scope);
    await importFlowMap(userId, (await exportFlowMap(userId, scope, evidence.evidenceId, "flow")).contents);
    // Feedback really stored before the Delete, so the check below proves the Delete removed it.
    const { saveEvidence } = await import("./flowStore");
    await saveEvidence(userId, { ...evidence, evidenceId: "evidence-gap", expectations: [{ id: "gap-1", pattern: "placement", areaId: "dashboard.header", occurrences: 3, coverage: 0.5, confidence: 0.5, state: "unconfirmed" }] });
    await reviewExpectation(userId, scope, "gap-1", "rejected");
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM workspace_flow_feedback WHERE user_id = ?", userId))[0].n).toBe(1);
    await deleteFlowData(userId);
    expect((await getWorkspace(second, scope, "tab-b")).workspace.placements.length).toBeGreaterThan(0);
    for (const table of ["workspace_flow_events", "workspace_flow_aggregates", "workspace_flow_imports", "workspace_flow_feedback"]) {
      expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = ?`, userId))[0].n).toBe(0);
    }
    expect((await q<{ enabled: boolean }>("SELECT enabled FROM workspace_flow_settings WHERE user_id = ?", userId))[0].enabled).toBe(false);
    expect((await q<{ enabled: boolean }>("SELECT enabled FROM workspace_flow_settings WHERE user_id = ?", second))[0].enabled).toBe(true);
  });

  it("does not resurrect events or aggregates when ingestion races deletion", async () => {
    await setFlowConsent(userId, true);
    await Promise.all([ingestFlowEvents(userId, [event({ id: "in-flight" })]), deleteFlowData(userId)]);
    await Promise.all([generateFlowEvidence(userId, scope).catch(() => null), deleteFlowData(userId)]);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM workspace_flow_events WHERE user_id = ?", userId))[0].n).toBe(0);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM workspace_flow_aggregates WHERE user_id = ?", userId))[0].n).toBe(0);
    expect(await ingestFlowEvents(userId, [event({ id: "after-delete" })])).toEqual({ received: 0, isolated: 1 });
  });

  it("trusts nothing a .flowmap says about itself, and takes none without consent", async () => {
    await setFlowConsent(userId, true);
    await ingestFlowEvents(userId, [event()]);
    const evidence = await generateFlowEvidence(userId, scope);
    const exported = JSON.parse((await exportFlowMap(userId, scope, evidence.evidenceId, "flow")).contents) as Record<string, unknown> & { evidence: { origin: string }; svg: string; checksum?: string };
    // A forged file: claims to be this device's own evidence and carries its own picture, with a valid checksum.
    delete exported.checksum;
    const body = { ...exported, evidence: { ...exported.evidence, origin: "local" }, svg: exported.svg.replace("</svg>", "<text>INJECTED</text></svg>") };
    const forged = JSON.stringify({ ...body, checksum: flowMapChecksum(body) });
    const imported = await importFlowMap(userId, forged);
    expect(imported.document.evidence.origin).toBe("import");
    expect(imported.document.svg).not.toContain("INJECTED");
    const [stored] = await q<{ document: string }>("SELECT document FROM workspace_flow_imports WHERE id = ?", imported.importId);
    expect(stored.document).not.toContain("INJECTED");
    await deleteFlowData(userId);
    await expect(importFlowMap(userId, forged)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM workspace_flow_imports WHERE user_id = ?", userId))[0].n).toBe(0);
  });

  it("keeps only the newest raw events of a user over the cap, and prunes at most once a minute", async () => {
    const { pruneFlowData, saveFlowEvents } = await import("./flowStore");
    await setFlowConsent(userId, true);
    const now = Date.now();
    await saveFlowEvents(userId, [event({ id: "oldest", occurredAt: now - 3000 }), event({ id: "middle", occurredAt: now - 2000 }), event({ id: "newest", occurredAt: now - 1000 })]);
    await pruneFlowData(userId, now + 120_000, 2);
    const ids = async () => (await q<{ id: string }>("SELECT id FROM workspace_flow_events WHERE user_id = ? ORDER BY id", userId)).map(row => row.id);
    expect(await ids()).toEqual(["middle", "newest"]);
    await pruneFlowData(userId, now + 130_000, 1);
    expect(await ids(), "pruned a moment ago").toHaveLength(2);
  });

  it("leaves drafts with no reference to the evidence a Delete removed", async () => {
    await q("INSERT INTO workspace_drafts (id, user_id, surface_id, device_class, base_revision, draft_revision, status, patches, created_at, updated_at) VALUES ('d', ?, 'dashboard', 'desktop', 'default', 1, 'editing', ?, ?, ?)",
      userId, JSON.stringify([{ patchId: "p", operations: [], evidence: [{ evidenceId: "evidence_x", effectiveRevision: "eff" }] }]), Date.now(), Date.now());
    await deleteFlowData(userId);
    const [draft] = await q<{ patches: string }>("SELECT patches FROM workspace_drafts WHERE id = 'd'");
    expect(JSON.parse(draft.patches)).toEqual([{ patchId: "p", operations: [], evidence: [] }]);
  });

  it("leaves a draft that referred to deleted evidence saveable and discardable", async () => {
    const { saveWorkspaceDraft, discardWorkspaceDraft } = await import("./service");
    const patch = {
      patchId: "patch-evidence", patchSchemaVersion: 1 as const, scope, baseRevision: "default", catalogVersion: "1.0.0", author: "deterministic" as const, provenance: {},
      intent: { kind: "reduce" as const, status: "proposed" as const, anchorId: "dashboard.stats" },
      operations: [{ type: "visibility" as const, operationId: "op-evidence", anchorId: "dashboard.stats", visible: false }],
      evidence: [{ evidenceId: "evidence_x", effectiveRevision: "eff" }], proposedConstraints: [], suggestionSignature: "signature-x", expectedOutcome: "Fewer clicks",
    };
    const first = { draftId: "draft-evidence", draftRevision: 1, baseRevision: "default", scope, status: "ready" as const, patches: [patch] };
    await saveWorkspaceDraft(userId, scope, first);
    await deleteFlowData(userId);
    const [stored] = await q<{ patches: string }>("SELECT patches FROM workspace_drafts WHERE id = 'draft-evidence'");
    const cleaned = JSON.parse(stored.patches);
    expect(cleaned[0].evidence).toEqual([]);
    expect(cleaned[0].suggestionSignature).toBeUndefined();
    expect(cleaned[0].expectedOutcome).toBeUndefined();
    await saveWorkspaceDraft(userId, scope, { ...first, draftRevision: 2, patches: cleaned });
    await discardWorkspaceDraft(userId, scope, "draft-evidence");
  });

  it("makes one period a day for whom collects, each drawn on the layout it was used on", async () => {
    await setFlowConsent(userId, true);
    await ingestFlowEvents(userId, [event()]);
    expect(await snapshotFlowEvidence()).toBe(1);
    expect(await snapshotFlowEvidence(), "not twice the same day").toBe(0);
    const overview = await flowMapOverview(userId, scope);
    expect(overview.evidence).toHaveLength(1);
    const layout = overview.layouts[overview.evidence[0].descriptor.effectiveRevision];
    expect(layout?.some(placement => placement.anchorId === "dashboard.customize" && placement.areaId === "dashboard.header")).toBe(true);
    await setFlowConsent(userId, false);
    await ingestFlowEvents(userId, [event({ id: "while-off" })]);
    // 21 h later: past the once-a-day guard and with the earlier event still in the window, only consent stops it.
    expect(await snapshotFlowEvidence(Date.now() + 21 * 3_600_000), "nobody collecting, nothing new").toBe(0);
  });

  it("shows the current week's use at once, worked out on the fly and stored nowhere", async () => {
    expect((await flowMapOverview(userId, scope)).live, "nothing collected").toBeNull();
    await setFlowConsent(userId, true);
    await ingestFlowEvents(userId, [event()]);
    const overview = await flowMapOverview(userId, scope);
    expect(overview.live?.heat.some(point => point.anchorId === "dashboard.customize" && point.activations === 1)).toBe(true);
    expect(overview.layouts[overview.live!.descriptor.effectiveRevision]?.some(row => row.anchorId === "dashboard.customize")).toBe(true);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM workspace_flow_aggregates WHERE user_id = ?", userId))[0].n, "a read writes nothing").toBe(0);
  });

  it("makes no period for a page whose new layout has not been used yet", async () => {
    await setFlowConsent(userId, true);
    // Used yesterday on a layout that is no longer the current one.
    const { saveFlowEvents } = await import("./flowStore");
    expect(await saveFlowEvents(userId, [event({ descriptor: { ...descriptor, effectiveRevision: "effective-earlier" } })])).toBe(1);
    expect(await snapshotFlowEvidence()).toBe(0);
    expect((await flowMapOverview(userId, scope)).evidence).toEqual([]);
  });
});

