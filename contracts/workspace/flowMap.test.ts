import { describe, expect, it } from "vitest";
import { aggregateEvidence, FLOW_EVENT_SCHEMA_VERSION, type FlowEvent } from "./flowMap";
import type { PresentationDescriptor, Scope } from "./model";

const scope: Scope = { surfaceId: "dashboard", deviceClass: "desktop" };
const descriptor: PresentationDescriptor = {
  effectiveRevision: "effective-a",
  sourceActiveRevision: "revision-a",
  workspaceFingerprint: "fingerprint-a",
  productDefaultVersion: "product-1",
  catalogVersion: "1.0.0",
  resolverVersion: 1,
  constraintsFingerprint: "constraints",
  feedbackFingerprint: "feedback",
  discoveryFingerprint: "discovery",
  rendererBindingsFingerprint: "renderers",
};
const NOW = Date.now();

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
    clientInstanceId: "client-a",
    presentationEpoch: 1,
    sessionId: "session-123456",
    sequence: 1,
    occurredAt: NOW,
    modality: "pointer",
    ...overrides,
  };
}

describe("FlowMap aggregation", () => {
  it("normalizes heat on exposure, keeps pointer cells local to anchors and reports gaps", () => {
    const events = [
      event({ id: "a", cell: { x: 7, y: 6 } }),
      event({ id: "b", kind: "anchor.exposure", controlId: undefined, anchorId: "dashboard.customize", modality: "unknown", cell: undefined }),
      event({ id: "c", kind: "action.succeeded" }),
      event({ id: "d", sequence: 4, kind: "anchor.exposure", controlId: undefined, anchorId: "dashboard.customize", modality: "unknown" }),
      event({ id: "other", descriptor: { ...descriptor, effectiveRevision: "other" } }),
    ];
    const result = aggregateEvidence(events, descriptor, scope, "evidence-a");
    expect(result.heat).toHaveLength(1);
    expect(result.heat[0]).toMatchObject({ activations: 1, successes: 1, exposures: 1, activationRate: 1 });
    expect(result.heat[0].cells[6][7]).toBe(1);
    expect(result.coverage.gaps).toBe(2);
  });

  it("keeps early exposures, control flows across exposure events and three-step loops", () => {
    const events = [
      event({ id: "early-exposure", kind: "anchor.exposure", controlId: undefined, sequence: 1 }),
      event({ id: "from", controlId: "dashboard.period.next", anchorId: "dashboard.period", sequence: 2 }),
      event({ id: "between-exposure", kind: "anchor.exposure", controlId: undefined, anchorId: "dashboard.period", sequence: 3 }),
      event({ id: "to", controlId: "dashboard.logTime", anchorId: "dashboard.quickActions", sequence: 4 }),
      event({ id: "return", controlId: "dashboard.period.next", anchorId: "dashboard.period", sequence: 5 }),
      event({ id: "customize", sequence: 6 }),
    ];
    const result = aggregateEvidence(events, descriptor, scope, "exposure-flow");
    expect(result.heat.find(point => point.controlId === "dashboard.customize.open")?.exposures).toBe(1);
    expect(result.flows).toEqual(expect.arrayContaining([
      { fromControlId: "dashboard.period.next", toControlId: "dashboard.logTime", count: 1 },
      { fromControlId: "dashboard.logTime", toControlId: "dashboard.period.next", count: 1 },
    ]));
    expect(result.friction.find(point => point.controlId === "dashboard.period.next")?.loops).toBe(1);
    expect(result.coverage.gaps).toBe(0);
  });

  it("requires five active days and thirty activations before proposing an expectation", () => {
    const insufficient = Array.from({ length: 29 }, (_, index) => event({ id: `small-${index}`, occurredAt: NOW - (index % 5) * 86_400_000, sessionId: `session-${index}` }));
    expect(aggregateEvidence(insufficient, descriptor, scope, "insufficient").expectations).toEqual([]);
    const events = Array.from({ length: 5 }, (_, day) => [
      event({ id: `from-${day}`, occurredAt: NOW - day * 86_400_000, sessionId: `session-${day}` }),
      event({ id: `to-${day}`, controlId: "dashboard.logTime", anchorId: "dashboard.quickActions", occurredAt: NOW - day * 86_400_000, sessionId: `session-${day}`, sequence: 2 }),
      event({ id: `from-again-${day}`, occurredAt: NOW - day * 86_400_000, sessionId: `session-${day}`, sequence: 3 }),
      event({ id: `to-again-${day}`, controlId: "dashboard.logTime", anchorId: "dashboard.quickActions", occurredAt: NOW - day * 86_400_000, sessionId: `session-${day}`, sequence: 4 }),
      event({ id: `from-last-${day}`, occurredAt: NOW - day * 86_400_000, sessionId: `session-${day}`, sequence: 5 }),
      event({ id: `to-last-${day}`, controlId: "dashboard.logTime", anchorId: "dashboard.quickActions", occurredAt: NOW - day * 86_400_000, sessionId: `session-${day}`, sequence: 6 }),
      event({ id: `success-${day}`, kind: "action.succeeded", controlId: "dashboard.logTime", anchorId: "dashboard.quickActions", occurredAt: NOW - day * 86_400_000, sessionId: `session-${day}`, sequence: 7 }),
    ]).flat();
    const result = aggregateEvidence(events, descriptor, scope, "enough", 0, { "dashboard.customize": "dashboard.header", "dashboard.quickActions": "dashboard.header" });
    expect(result.coverage.activeDays).toBe(5);
    expect(result.expectations).toHaveLength(1);
    expect(result.expectations[0]).toMatchObject({ areaId: "dashboard.header", destinationControlId: "dashboard.logTime", occurrences: 15, state: "unconfirmed" });
    expect(result.friction.some(point => point.backtracks > 0)).toBe(true);
    expect(result.coverage.sessions).toBe(5);
  });

  it("never mixes effective revisions in flows or coverage", () => {
    const first = event({ id: "first", sessionId: "same-session" });
    const second = event({ id: "second", sessionId: "same-session", sequence: 2, controlId: "dashboard.logTime", anchorId: "dashboard.quickActions", descriptor: { ...descriptor, effectiveRevision: "effective-b" } });
    const result = aggregateEvidence([first, second], descriptor, scope, "separate");
    expect(result.heat).toHaveLength(1);
    expect(result.flows).toEqual([]);
    expect(result.coverage.activeDays).toBe(1);
  });

  it("separates discoverability hypotheses from unnamed missing capabilities", () => {
    const shellScope: Scope = { surfaceId: "shell-desktop", deviceClass: "desktop" };
    const events = Array.from({ length: 5 }, (_, day) => [
      ...Array.from({ length: 3 }, (_, step) => [
        event({ id: `open-${day}-${step}`, scope: shellScope, controlId: "shell.search.open", anchorId: "shell.search", occurredAt: NOW - day * 86_400_000, sessionId: `search-${day}`, sequence: step * 3 + 1 }),
        event({ id: `search-${day}-${step}`, kind: "search.opened" as const, scope: shellScope, controlId: "shell.search.open", anchorId: "shell.search", occurredAt: NOW - day * 86_400_000, sessionId: `search-${day}`, sequence: step * 3 + 2 }),
        event({ id: `select-${day}-${step}`, kind: "search.selected" as const, scope: shellScope, controlId: "shell.search.select", anchorId: "shell.search", destinationControlId: "shell.nav.issues", occurredAt: NOW - day * 86_400_000, sessionId: `search-${day}`, sequence: step * 3 + 3 }),
      ]),
      ...Array.from({ length: 3 }, (_, step) => event({ id: `notification-${day}-${step}`, scope: shellScope, controlId: "shell.notifications.open", anchorId: "shell.notifications", occurredAt: NOW - day * 86_400_000, sessionId: `search-${day}`, sequence: 10 + step })),
      ...(day < 3 ? [event({ id: `abandoned-${day}`, kind: "search.abandoned" as const, scope: shellScope, controlId: "shell.search.open", anchorId: "shell.search", occurredAt: NOW - day * 86_400_000, sessionId: `search-${day}`, sequence: 14 })] : []),
    ]).flat(2);
    const result = aggregateEvidence(events, descriptor, shellScope, "search-evidence", 0, { "shell.search": "shell.navigation", "shell.notifications": "shell.navigation" });
    expect(result.expectations).toEqual(expect.arrayContaining([
      expect.objectContaining({ pattern: "discoverability", destinationControlId: "shell.nav.issues", occurrences: 5 }),
      expect.objectContaining({ pattern: "missing-capability", occurrences: 3, confidence: 0.25 }),
    ]));
    expect(result.expectations.find(gap => gap.pattern === "missing-capability")?.destinationControlId).toBeUndefined();
  });
});

describe("FlowMap checksum input", () => {
  it("orders keys by code unit, not by the server's locale", async () => {
    const { flowMapChecksumInput } = await import("./flowMap");
    // A locale puts "_" before letters; code-unit order puts "B" (0x42) before "_" (0x5f).
    expect(flowMapChecksumInput({ a_b: 2, aB: 1 })).toBe('{"aB":1,"a_b":2}');
  });
});

describe("FlowMap active days", () => {
  it("counts the user's local days, not UTC ones", () => {
    // Europe/Rome (the test TZ): 00:30 local is still the previous UTC day.
    const early = new Date(2026, 10, 2, 0, 30).getTime();
    const late = new Date(2026, 10, 2, 23, 30).getTime();
    const evidence = aggregateEvidence([event({ occurredAt: early }), event({ occurredAt: late, sequence: 2 })], descriptor, scope, "evidence-days");
    expect(evidence.coverage.activeDays).toBe(1);
  });
});
