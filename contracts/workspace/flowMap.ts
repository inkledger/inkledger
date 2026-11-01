import type { CatalogManifest } from "./catalogTypes";
import type { PresentationDescriptor, ResolvedWorkspace, Scope } from "./model";

export const FLOW_EVENT_SCHEMA_VERSION = 1;
export const FLOW_AGGREGATION_VERSION = 1;
export const FLOW_MAP_VERSION = 1;
export const FLOW_MIN_ACTIVE_DAYS = 5;
export const FLOW_MIN_ACTIVATIONS = 30;

export type FlowEventKind =
  | "surface.view"
  | "anchor.exposure"
  | "control.activate"
  | "navigation.completed"
  | "action.succeeded"
  | "action.failed"
  | "search.opened"
  | "search.selected"
  | "search.abandoned"
  | "layout.committed"
  | "layout.presented"
  | "layout.undone"
  | "discovery.seen"
  | "discovery.placed";
export type FlowModality = "pointer" | "touch" | "keyboard" | "unknown";
export type FlowCell = { x: number; y: number };
export type FlowEvent = {
  eventSchemaVersion: typeof FLOW_EVENT_SCHEMA_VERSION;
  id: string;
  kind: FlowEventKind;
  scope: Scope;
  controlId?: string;
  anchorId?: string;
  areaId?: string;
  destinationControlId?: string;
  semanticRevision: number;
  descriptor: PresentationDescriptor;
  observedCommittedRevision?: string;
  clientInstanceId: string;
  presentationEpoch: number;
  activationId?: string;
  sessionId: string;
  sequence: number;
  occurredAt: number;
  durationMs?: number;
  droppedBefore?: number;
  modality: FlowModality;
  cell?: FlowCell;
};

export type HeatPoint = {
  controlId: string;
  anchorId: string;
  semanticRevision: number;
  activations: number;
  successes: number;
  failures: number;
  exposures: number;
  activationRate: number;
  modalities: Record<FlowModality, number>;
  cells: number[][];
};
export type FlowTransition = { fromControlId: string; toControlId: string; count: number };
export type FrictionPoint = {
  controlId: string;
  abandoned: number;
  failures: number;
  backtracks: number;
  loops: number;
};
export type ExpectationGap = {
  id: string;
  pattern: "placement" | "discoverability" | "missing-capability";
  areaId: string;
  destinationControlId?: string;
  occurrences: number;
  coverage: number;
  confidence: number;
  state: "unconfirmed" | "confirmed" | "rejected";
};
export type EvidenceCoverage = {
  firstAt: number;
  lastAt: number;
  activeDays: number;
  sessions: number;
  exposures: number;
  droppedEvents: number;
  gaps: number;
};
export type EvidenceSet = {
  evidenceId: string;
  scope: Scope;
  descriptor: PresentationDescriptor;
  semanticRevision: number;
  algorithmVersion: typeof FLOW_AGGREGATION_VERSION;
  origin: "local" | "import";
  coverage: EvidenceCoverage;
  heat: readonly HeatPoint[];
  flows: readonly FlowTransition[];
  friction: readonly FrictionPoint[];
  expectations: readonly ExpectationGap[];
};
export type FlowMapView = "heat" | "flow" | "friction" | "expectation";
export type FlowMapDocument = {
  format: "flowmap";
  version: typeof FLOW_MAP_VERSION;
  generatedAt: number;
  scope: Scope;
  view: FlowMapView;
  evidence: EvidenceSet;
  catalog: {
    catalogVersion: CatalogManifest["catalogVersion"];
    areas: readonly Pick<CatalogManifest["areas"][number], "id" | "surfaceId" | "role" | "capacity" | "allowedAnchorIds">[];
    anchors: readonly Pick<CatalogManifest["anchors"][number], "id" | "surfaceId" | "renderer" | "semanticRevision">[];
    controls: readonly Pick<CatalogManifest["controls"][number], "id" | "anchorId" | "kind" | "semanticRevision">[];
    tombstones: CatalogManifest["tombstones"];
  };
  workspace: Pick<ResolvedWorkspace, "placements" | "catalogVersion" | "productDefaultVersion" | "resolverVersion">;
  svg: string;
  checksum: string;
};

export function expectationId(gap: Omit<ExpectationGap, "id" | "state">): string {
  return [gap.pattern, gap.areaId, gap.destinationControlId ?? "unresolved"].join(":");
}

export function aggregateEvidence(
  events: readonly FlowEvent[],
  descriptor: PresentationDescriptor,
  scope: Scope,
  evidenceId: string,
  droppedEvents = 0,
  areasByAnchor: Readonly<Record<string, string>> = {},
): EvidenceSet {
  const heat = new Map<string, {
    controlId: string;
    anchorId: string;
    semanticRevision: number;
    activations: number;
    successes: number;
    failures: number;
    exposures: number;
    activationRate: number;
    modalities: Record<FlowModality, number>;
    cells: number[][];
  }>();
  const flows = new Map<string, FlowTransition>();
  const friction = new Map<string, FrictionPoint>();
  const days = new Set<number>();
  const sessions = new Set<string>();
  const exposures = new Map<string, string>();
  const exposuresByAnchor = new Map<string, number>();
  let firstAt = Number.POSITIVE_INFINITY;
  let lastAt = 0;
  let gaps = droppedEvents;
  const previousBySession = new Map<string, FlowEvent>();
  const previousEventBySession = new Map<string, FlowEvent>();
  const searches = new Map<string, { anchorId?: string; selected: FlowEvent[]; abandoned: number }>();
  const sorted = [...events].sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.sequence - b.sequence || a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
  for (const event of sorted) {
    if (event.descriptor.effectiveRevision !== descriptor.effectiveRevision) continue;
    if (event.droppedBefore) gaps += event.droppedBefore;
    firstAt = Math.min(firstAt, event.occurredAt);
    lastAt = Math.max(lastAt, event.occurredAt);
    days.add(Math.floor(event.occurredAt / 86_400_000));
    sessions.add(event.sessionId);
    const controlId = event.controlId ?? event.anchorId ?? event.scope.surfaceId;
    if (event.kind === "control.activate" || event.kind === "action.succeeded" || event.kind === "action.failed") {
      const point = heat.get(controlId) ?? {
        controlId,
        anchorId: event.anchorId ?? "",
        semanticRevision: event.semanticRevision,
        activations: 0,
        successes: 0,
        failures: 0,
        exposures: 0,
        activationRate: 0,
        modalities: { pointer: 0, touch: 0, keyboard: 0, unknown: 0 },
        cells: Array.from({ length: 8 }, () => Array<number>(8).fill(0)),
      };
      if (event.kind === "control.activate") {
        point.activations++;
        point.modalities[event.modality]++;
        if (event.cell) point.cells[event.cell.y][event.cell.x]++;
      } else if (event.kind === "action.succeeded") point.successes++;
      else point.failures++;
      heat.set(controlId, point);
    }
    if (event.kind === "anchor.exposure" && event.anchorId) {
      const key = `${event.sessionId}:${event.anchorId}`;
      if (exposures.has(key)) gaps++;
      else {
        exposures.set(key, event.id);
        exposuresByAnchor.set(event.anchorId, (exposuresByAnchor.get(event.anchorId) ?? 0) + 1);
      }
    }
    const previous = previousBySession.get(event.sessionId);
    const previousEvent = previousEventBySession.get(event.sessionId);
    if (event.kind === "search.opened") searches.set(event.sessionId, { anchorId: event.anchorId, selected: [], abandoned: 0 });
    if (event.kind === "search.selected") {
      const search = searches.get(event.sessionId) ?? { anchorId: event.anchorId, selected: [], abandoned: 0 };
      search.selected.push(event);
      search.anchorId ??= event.anchorId;
      searches.set(event.sessionId, search);
    }
    if (event.kind === "search.abandoned") {
      const search = searches.get(event.sessionId) ?? { anchorId: event.anchorId, selected: [], abandoned: 0 };
      search.abandoned++;
      searches.set(event.sessionId, search);
    }
    if (previousEvent && previousEvent.scope.surfaceId === event.scope.surfaceId && event.sequence > previousEvent.sequence + 1) gaps++;
    if (previous?.controlId && event.controlId && previous.controlId !== event.controlId) {
      const key = `${previous.controlId}:${event.controlId}`;
      const edge = flows.get(key) ?? { fromControlId: previous.controlId, toControlId: event.controlId, count: 0 };
      edge.count++;
      flows.set(key, edge);
      if (event.controlId === previousBySession.get(`${event.sessionId}:before`)?.controlId) {
        const point = friction.get(previous.controlId) ?? { controlId: previous.controlId, abandoned: 0, failures: 0, backtracks: 0, loops: 0 };
        point.backtracks++;
        friction.set(previous.controlId, point);
        const loop = friction.get(event.controlId) ?? { controlId: event.controlId, abandoned: 0, failures: 0, backtracks: 0, loops: 0 };
        loop.loops++;
        friction.set(event.controlId, loop);
      }
      previousBySession.set(`${event.sessionId}:before`, previous);
    }
    if (event.kind === "action.failed" || event.kind === "search.abandoned") {
      const point = friction.get(controlId) ?? { controlId, abandoned: 0, failures: 0, backtracks: 0, loops: 0 };
      if (event.kind === "search.abandoned") point.abandoned++;
      else point.failures++;
      friction.set(controlId, point);
    }
    if (event.controlId) previousBySession.set(event.sessionId, event);
    previousEventBySession.set(event.sessionId, event);
  }
  const heatPoints = [...heat.values()].map(point => {
    const exposures = exposuresByAnchor.get(point.anchorId) ?? 0;
    return { ...point, exposures, activationRate: exposures ? point.activations / exposures : 0 };
  });
  const transition = [...flows.values()].sort((a, b) => b.count - a.count || a.fromControlId.localeCompare(b.fromControlId) || a.toControlId.localeCompare(b.toControlId));
  const activations = heatPoints.reduce((sum, point) => sum + point.activations, 0);
  const expectations: ExpectationGap[] = [];
  if (days.size >= FLOW_MIN_ACTIVE_DAYS && activations >= FLOW_MIN_ACTIVATIONS) {
    for (const edge of transition.filter(edge => edge.count >= 3 && !edge.toControlId.startsWith("shell.nav."))) {
      const destination = heatPoints.find(point => point.controlId === edge.toControlId);
      if (!destination || destination.successes < 3) continue;
      const source = heatPoints.find(point => point.controlId === edge.fromControlId);
      const anchorId = source?.anchorId || destination.anchorId;
      const areaId = areasByAnchor[anchorId];
      if (!areaId) continue;
      const occurrences = edge.count;
      const confidence = Math.min(0.85, 0.3 + occurrences / Math.max(activations, 1));
      const gap = { pattern: "placement" as const, areaId, destinationControlId: edge.toControlId, occurrences, coverage: exposures.size ? Math.min(1, destination.exposures / exposures.size) : 0, confidence };
      expectations.push({ ...gap, id: expectationId(gap), state: "unconfirmed" });
    }
    const searchGaps = new Map<string, ExpectationGap>();
    const addSearchGap = (gap: Omit<ExpectationGap, "id" | "state">) => {
      const id = expectationId(gap);
      const existing = searchGaps.get(id);
      searchGaps.set(id, { ...gap, id, state: "unconfirmed", occurrences: (existing?.occurrences ?? 0) + gap.occurrences, coverage: Math.min(1, (existing?.coverage ?? 0) + gap.coverage), confidence: gap.pattern === "missing-capability" ? 0.25 : Math.min(0.85, (existing?.confidence ?? 0) + gap.confidence / 5) });
    };
    for (const search of searches.values()) {
      const areaId = search.anchorId ? areasByAnchor[search.anchorId] : undefined;
      if (!areaId) continue;
      for (const selected of search.selected) {
        if (!selected.destinationControlId) continue;
        addSearchGap({ pattern: "discoverability", areaId, destinationControlId: selected.destinationControlId, occurrences: 1, coverage: Math.min(1, 1 / Math.max(1, sessions.size)), confidence: Math.min(0.85, 0.3 + search.selected.length / Math.max(activations, 1)) });
      }
      if (search.abandoned > 0) addSearchGap({ pattern: "missing-capability", areaId, occurrences: search.abandoned, coverage: Math.min(1, search.abandoned / Math.max(1, sessions.size)), confidence: 0.25 });
    }
    for (const [id, gap] of searchGaps) if (gap.pattern === "missing-capability" && gap.occurrences < 3) searchGaps.delete(id);
    expectations.push(...searchGaps.values());
  }
  return {
    evidenceId,
    scope,
    descriptor,
    semanticRevision: Math.max(0, ...heatPoints.map(point => point.semanticRevision)),
    algorithmVersion: FLOW_AGGREGATION_VERSION,
    origin: "local",
    coverage: {
      firstAt: Number.isFinite(firstAt) ? firstAt : 0,
      lastAt,
      activeDays: days.size,
      sessions: sessions.size,
      exposures: exposures.size,
      droppedEvents,
      gaps,
    },
    heat: heatPoints.sort((a, b) => a.controlId.localeCompare(b.controlId)),
    flows: transition,
    friction: [...friction.values()].sort((a, b) => a.controlId.localeCompare(b.controlId)),
    expectations,
  };
}

export function flowMapChecksumInput(document: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("FlowMap requires finite numbers");
    if (typeof value === "string") return value.normalize("NFC");
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  };
  return JSON.stringify(normalize(document));
}
