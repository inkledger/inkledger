import { t } from "@contracts/i18n";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { attributeEvent } from "@contracts/workspace/applyMachine";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import { scopeFor } from "@contracts/workspace/catalog";
import { FLOW_AGGREGATION_VERSION, aggregateEvidence, flowMapChecksumInput, type EvidenceSet, type FlowEvent, type FlowMapDocument, type FlowMapView } from "@contracts/workspace/flowMap";
import type { Scope } from "@contracts/workspace/model";
import { digestBytes, fingerprint } from "./crypto";
import { loadApplyState } from "./store";
import { getWorkspace, workspaceAtDescriptor } from "./service";
import { assertStaticSvg, flowMapDocumentSchema } from "./flowValidation";
import { renderFlowMapSvg } from "./flowSvg";
import {
  evidenceById,
  feedbackById,
  flowSnapshotCandidates,
  getFlowSettings,
  listEvidence,
  listFlowImports,
  loadFlowEvents,
  pruneFlowData,
  saveEvidence,
  saveFlowEvents,
  saveFlowImport,
  setExpectationFeedback,
} from "./flowStore";

export function flowMapChecksum(document: unknown): string {
  return digestBytes(new TextEncoder().encode(`flowmap-v1\n${flowMapChecksumInput(document)}`));
}

function checkEventCatalog(event: FlowEvent): boolean {
  try {
    scopeFor(CATALOG_V1, event.scope.surfaceId, event.scope.deviceClass);
  } catch {
    return false;
  }
  if (event.kind === "surface.view") return !event.controlId && !event.anchorId && !event.areaId && event.semanticRevision === 1;
  if (event.kind.startsWith("layout.")) return false;
  const anchor = event.anchorId ? CATALOG_V1.anchors.find(item => item.id === event.anchorId && item.surfaceId === event.scope.surfaceId) : undefined;
  if (event.anchorId && !anchor) return false;
  if (event.kind === "anchor.exposure") return Boolean(anchor) && !event.areaId && event.semanticRevision === anchor!.semanticRevision;
  if (event.kind === "discovery.seen" || event.kind === "discovery.placed") {
    if (event.areaId) return !event.anchorId && event.semanticRevision === 1 && CATALOG_V1.areas.some(area => area.id === event.areaId && area.surfaceId === event.scope.surfaceId);
    return Boolean(anchor) && event.semanticRevision === anchor!.semanticRevision;
  }
  if (event.areaId) return false;
  const control = event.controlId ? CATALOG_V1.controls.find(item => item.id === event.controlId) : undefined;
  if (!control || control.anchorId !== event.anchorId || control.semanticRevision !== event.semanticRevision) return false;
  if (control.interactions.some(item => item.telemetry === "disabled")) return false;
  if (event.destinationControlId && (!["search.selected", "navigation.completed"].includes(event.kind) || !CATALOG_V1.controls.some(item => item.id === event.destinationControlId && item.interactions.some(interaction => interaction.telemetry === "allowed")))) return false;
  const expected = event.kind === "control.activate" ? ["activate", "navigate"]
    : event.kind === "navigation.completed" ? ["navigate"]
      : event.kind === "action.succeeded" ? ["succeed"]
        : event.kind === "action.failed" ? ["fail"]
          : event.kind === "search.opened" && control.id === "shell.search.open" ? ["activate"]
            : event.kind === "search.selected" && control.id === "shell.search.select" ? ["navigate"]
              : event.kind === "search.abandoned" && control.id === "shell.search.open" ? ["abandoned"] : [];
  return expected.some(kind => kind === "abandoned" || control.interactions.some(item => item.kind === kind && item.telemetry === "allowed"));
}

export async function ingestFlowEvents(userId: number, events: readonly FlowEvent[]) {
  const settings = await getFlowSettings(userId);
  if (!settings.enabled) return { received: 0, isolated: events.length };
  await pruneFlowData(userId);
  const now = Date.now();
  const accepted: FlowEvent[] = [];
  let isolated = 0;
  const states = new Map<string, Awaited<ReturnType<typeof loadApplyState>>>();
  for (const event of events) {
    const key = `${event.scope.surfaceId}:${event.scope.deviceClass}`;
    const state = states.get(key) ?? await loadApplyState(userId, event.scope);
    states.set(key, state);
    const attribution = attributeEvent(state, {
      clientInstanceId: event.clientInstanceId,
      effectiveRevision: event.descriptor.effectiveRevision,
      workspaceFingerprint: event.descriptor.workspaceFingerprint,
      presentationEpoch: event.presentationEpoch,
      ...(event.activationId ? { activationId: event.activationId } : {}),
    });
    const fresh = event.occurredAt <= now + 300_000 && event.occurredAt >= now - settings.rawRetentionDays * 86_400_000;
    if (!fresh || attribution.kind !== "attributed" || !checkEventCatalog(event)) {
      isolated++;
      continue;
    }
    accepted.push({ ...event, descriptor: attribution.descriptor });
  }
  const stored = await saveFlowEvents(userId, accepted);
  return { received: accepted.length, stored, isolated };
}

/** `since`: only the events from then on (the daily snapshot's rolling week), else every event of that presentation. */
export async function generateFlowEvidence(userId: number, scope: Scope, effectiveRevision?: string, since?: number): Promise<EvidenceSet> {
  if (!(await getFlowSettings(userId)).enabled) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.workspace.flowOff") });
  await pruneFlowData(userId);
  const current = await getWorkspace(userId, scope, "ssr");
  const snapshot = await workspaceAtDescriptor(userId, scope, effectiveRevision ?? current.descriptor.effectiveRevision);
  if (!snapshot) throw new TRPCError({ code: "NOT_FOUND", message: t("server.workspace.gone") });
  const events = await loadFlowEvents(userId, scope, snapshot.descriptor.effectiveRevision, since);
  const id = `evidence_${fingerprint("workspace", { algorithm: FLOW_AGGREGATION_VERSION, effectiveRevision: snapshot.descriptor.effectiveRevision, eventIds: events.map(event => event.id).sort() }).value}`;
  const areasByAnchor = Object.fromEntries(snapshot.workspace.placements.map(placement => [placement.anchorId, placement.areaId]));
  const evidence = aggregateEvidence(events, snapshot.descriptor, scope, id, 0, areasByAnchor);
  const feedback = await feedbackById(userId);
  const withFeedback = { ...evidence, expectations: evidence.expectations.map(gap => ({ ...gap, state: feedback[gap.id] ?? gap.state })) };
  await saveEvidence(userId, withFeedback);
  return withFeedback;
}

export async function flowMapOverview(userId: number, scope: Scope) {
  const evidence = await listEvidence(userId, scope);
  // The layout each period was used on, so its map draws that page as it was (null: not drawable on this version).
  const layouts: Record<string, { anchorId: string; areaId: string; order: number; visible: boolean }[] | null> = {};
  for (const item of evidence.filter(entry => entry.origin === "local")) {
    const revision = item.descriptor.effectiveRevision;
    if (revision in layouts) continue;
    const snapshot = await workspaceAtDescriptor(userId, scope, revision).catch(() => null);
    layouts[revision] = snapshot ? snapshot.workspace.placements.map(({ anchorId, areaId, order, visible }) => ({ anchorId, areaId, order, visible })) : null;
  }
  return {
    settings: await getFlowSettings(userId),
    evidence,
    layouts,
    imports: await listFlowImports(userId, scope),
  };
}

export async function exportFlowMap(userId: number, scope: Scope, evidenceId: string, view: FlowMapView): Promise<{ filename: string; contents: string }> {
  const evidence = await evidenceById(userId, evidenceId, scope);
  if (!evidence) throw new TRPCError({ code: "NOT_FOUND", message: t("server.workspace.evidenceGone") });
  const snapshot = await workspaceAtDescriptor(userId, scope, evidence.descriptor.effectiveRevision);
  if (!snapshot) throw new TRPCError({ code: "CONFLICT", message: t("server.workspace.oldView") });
  const svg = renderFlowMapSvg(evidence, snapshot.workspace.placements, view);
  assertStaticSvg(svg);
  const document = {
    format: "flowmap" as const,
    version: 1 as const,
    generatedAt: Date.now(),
    scope,
    view,
    evidence,
    catalog: {
      catalogVersion: CATALOG_V1.catalogVersion,
      areas: CATALOG_V1.areas.filter(area => area.surfaceId === scope.surfaceId).map(({ id, surfaceId, role, capacity, allowedAnchorIds }) => ({ id, surfaceId, role, capacity, allowedAnchorIds })),
      anchors: CATALOG_V1.anchors.filter(anchor => anchor.surfaceId === scope.surfaceId).map(({ id, surfaceId, renderer, semanticRevision }) => ({ id, surfaceId, renderer, semanticRevision })),
      controls: CATALOG_V1.controls.filter(control => CATALOG_V1.anchors.some(anchor => anchor.id === control.anchorId && anchor.surfaceId === scope.surfaceId)).map(({ id, anchorId, kind, semanticRevision }) => ({ id, anchorId, kind, semanticRevision })),
      tombstones: CATALOG_V1.tombstones,
    },
    workspace: {
      placements: snapshot.workspace.placements,
      catalogVersion: snapshot.workspace.catalogVersion,
      productDefaultVersion: snapshot.workspace.productDefaultVersion,
      resolverVersion: snapshot.workspace.resolverVersion,
    },
    svg,
  };
  const complete: FlowMapDocument = { ...document, checksum: flowMapChecksum(document) };
  return { filename: `flowmap-${scope.surfaceId}-${view}.flowmap`, contents: JSON.stringify(complete, null, 2) };
}

export async function importFlowMap(userId: number, text: string) {
  if (text.length > 512_000) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: t("server.workspace.tooLarge") });
  let document: FlowMapDocument;
  try {
    const { checksum, ...body } = flowMapDocumentSchema.parse(JSON.parse(text));
    if (flowMapChecksum(body) !== checksum) throw new Error("Checksum mismatch");
    assertStaticSvg(body.svg);
    scopeFor(CATALOG_V1, body.scope.surfaceId, body.scope.deviceClass);
    // What the file says about itself is not trusted: it is an import of this scope, and its picture
    // is drawn again here from its numbers, never kept as sent (P-02, P-03).
    const evidence = { ...body.evidence, origin: "import" as const, scope: body.scope };
    const sanitized = { ...body, evidence, svg: renderFlowMapSvg(evidence, body.workspace.placements, body.view) };
    assertStaticSvg(sanitized.svg);
    document = { ...sanitized, checksum: flowMapChecksum(sanitized) };
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: t("server.workspace.invalidFile") });
  }
  const importId = `import_${randomUUID()}`;
  await saveFlowImport(userId, document, importId);
  return { importId, origin: "import" as const, document };
}

export async function reviewExpectation(userId: number, scope: Scope, expectationId: string, status: "confirmed" | "rejected" | "unconfirmed") {
  const known = (await listEvidence(userId, scope)).some(evidence => evidence.expectations.some(gap => gap.id === expectationId));
  if (!known) throw new TRPCError({ code: "NOT_FOUND", message: t("server.workspace.evidenceGone") });
  await setExpectationFeedback(userId, expectationId, status);
  return { expectationId, status, constraintCreated: false };
}

export { deleteFlowData, getFlowSettings, setFlowConsent } from "./flowStore";

const DAY = 86_400_000;

/**
 * Once a day per page, for whom collects: the last week of use as a new period, so the maps show how
 * use changes without anyone pressing "Update evidence". Nothing new, nothing made.
 */
export async function snapshotFlowEvidence(now = Date.now()): Promise<number> {
  let made = 0;
  for (const candidate of await flowSnapshotCandidates(now - DAY)) {
    if (candidate.newestEvidenceAt !== null && candidate.newestEvidenceAt > now - 20 * 3_600_000) continue;
    const scope = { surfaceId: candidate.surfaceId, deviceClass: candidate.deviceClass } as Scope;
    // A page whose layout cannot be drawn any more just waits for the next one.
    made += await generateFlowEvidence(candidate.userId, scope, undefined, now - 7 * DAY).then(() => 1, () => 0);
  }
  return made;
}
