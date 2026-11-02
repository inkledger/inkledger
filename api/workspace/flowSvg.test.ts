import { describe, expect, it } from "vitest";
import { FLOW_AGGREGATION_VERSION, type EvidenceSet } from "@contracts/workspace/flowMap";
import { renderFlowMapSvg } from "./flowSvg";

const evidence: EvidenceSet = {
  evidenceId: "evidence-1",
  scope: { surfaceId: "dashboard", deviceClass: "desktop" },
  descriptor: {
    effectiveRevision: "eff_0123456789abcdef",
    sourceActiveRevision: "wr_revision",
    workspaceFingerprint: "fingerprint",
    productDefaultVersion: "product-1",
    catalogVersion: "1.0.0",
    resolverVersion: 1,
    constraintsFingerprint: "c",
    feedbackFingerprint: "f",
    discoveryFingerprint: "d",
    rendererBindingsFingerprint: "r",
  },
  semanticRevision: 1,
  algorithmVersion: FLOW_AGGREGATION_VERSION,
  origin: "local",
  coverage: { firstAt: Date.UTC(2026, 10, 2, 9), lastAt: Date.UTC(2026, 10, 3, 9), activeDays: 2, sessions: 1, exposures: 4, droppedEvents: 0, gaps: 0 },
  heat: [{ controlId: "dashboard.logTime", anchorId: "dashboard.quickActions", semanticRevision: 1, activations: 3, successes: 3, failures: 0, exposures: 4, activationRate: 0.75, modalities: { pointer: 3, keyboard: 0, touch: 0, unknown: 0 }, cells: [] }],
  flows: [],
  friction: [],
  expectations: [],
};

describe("the FlowMap picture", () => {
  it("names controls and the period the way the app does, never by internal ids", () => {
    const svg = renderFlowMapSvg(evidence, [], "heat");
    expect(svg).not.toMatch(/eff_|wr_|dashboard\.logTime|dashboard\.quickActions/);
    expect(svg).toContain("Log time");
    expect(svg).toContain("2026-11-02 – 2026-11-03");
  });
});
