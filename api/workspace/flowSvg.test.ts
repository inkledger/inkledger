import { describe, expect, it } from "vitest";
import { FLOW_AGGREGATION_VERSION, type EvidenceSet } from "@contracts/workspace/flowMap";
import { PRODUCT_DEFAULTS_V1 } from "@contracts/workspace/catalogV1";
import { productDefaultFor } from "@contracts/workspace/catalog";
import { sketchFor } from "@contracts/workspace/sketch";
import type { ResolvedPlacement } from "@contracts/workspace/model";
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

describe("the FlowMap picture of use, drawn on the layout", () => {
  const placements: ResolvedPlacement[] = productDefaultFor(PRODUCT_DEFAULTS_V1, "dashboard").placements.map(placement => ({ ...placement, origin: "product" as const }));
  const drawnAreas = new Set(sketchFor(evidence.scope)!.areas.filter(area => area.region !== "tray").map(area => area.areaId));
  const drawn = placements.filter(placement => placement.visible && drawnAreas.has(placement.areaId));
  const cells = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
  cells[1][6] = 2;
  cells[5][0] = 1;
  const used: EvidenceSet = { ...evidence, heat: [{ ...evidence.heat[0], cells }] };
  const count = (svg: string, pattern: RegExp) => svg.match(pattern)?.length ?? 0;

  it("draws one rect per visible block of the page and a frame per area, named, never by id", () => {
    const svg = renderFlowMapSvg(used, placements, "heat");
    expect(count(svg, /<rect [^>]*class="block"/g)).toBe(drawn.length);
    expect(count(svg, /<rect [^>]*class="area"/g)).toBeGreaterThan(1);
    expect(svg).toContain("Log time");
    expect(svg).toContain("3 uses");
    expect(svg).not.toMatch(/eff_|wr_|dashboard\.logTime|dashboard\.quickActions/);
  });

  it("puts a dot where the clicks landed in the block, only there", () => {
    const svg = renderFlowMapSvg(used, placements, "heat");
    expect(count(svg, /class="hit"/g)).toBe(2);
  });

  it("draws the page flat with no use: every block, no dots, no counts", () => {
    const svg = renderFlowMapSvg({ ...evidence, heat: [] }, placements, "heat");
    expect(count(svg, /<rect [^>]*class="block"/g)).toBe(drawn.length);
    expect(count(svg, /class="hit"/g)).toBe(0);
    expect(svg).not.toMatch(/\d+ uses?</);
    expect(svg).toContain("No clicks yet in this period");
  });
});
