import { z } from "zod";
import { FLOW_AGGREGATION_VERSION, FLOW_EVENT_SCHEMA_VERSION, FLOW_MAP_VERSION } from "@contracts/workspace/flowMap";
import { presentationDescriptorSchema, workspaceInputSchemas } from "./validation";

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const eventKind = z.enum([
  "surface.view", "anchor.exposure", "control.activate", "navigation.completed",
  "action.succeeded", "action.failed", "search.opened", "search.selected", "search.abandoned",
  "layout.committed", "layout.presented", "layout.undone", "discovery.seen", "discovery.placed",
]);
const event = z.strictObject({
  eventSchemaVersion: z.literal(FLOW_EVENT_SCHEMA_VERSION),
  id,
  kind: eventKind,
  scope: workspaceInputSchemas.scope,
  controlId: id.optional(),
  anchorId: id.optional(),
  areaId: id.optional(),
  destinationControlId: id.optional(),
  semanticRevision: z.number().int().positive().max(10_000),
  descriptor: presentationDescriptorSchema,
  observedCommittedRevision: id.optional(),
  clientInstanceId: z.string().min(1).max(128),
  presentationEpoch: z.number().int().positive(),
  activationId: z.string().min(1).max(128).optional(),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  sequence: z.number().int().positive().max(1_000_000),
  occurredAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  droppedBefore: z.number().int().positive().max(500).optional(),
  modality: z.enum(["pointer", "touch", "keyboard", "unknown"]),
  cell: z.strictObject({ x: z.number().int().min(0).max(7), y: z.number().int().min(0).max(7) }).optional(),
}).superRefine((value, context) => {
  if (value.cell && value.modality !== "pointer") context.addIssue({ code: "custom", message: "Normalized cells are pointer-only" });
  if (value.controlId && !value.anchorId) context.addIssue({ code: "custom", message: "Controls require their anchor" });
});

const heat = z.strictObject({
  controlId: id,
  anchorId: id,
  semanticRevision: z.number().int().nonnegative(),
  activations: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  exposures: z.number().int().nonnegative(),
  activationRate: z.number().finite().nonnegative(),
  modalities: z.strictObject({ pointer: z.number().int().nonnegative(), touch: z.number().int().nonnegative(), keyboard: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }),
  cells: z.array(z.array(z.number().int().nonnegative()).length(8)).length(8),
});
const evidence = z.strictObject({
  evidenceId: id,
  scope: workspaceInputSchemas.scope,
  descriptor: presentationDescriptorSchema,
  semanticRevision: z.number().int().nonnegative(),
  algorithmVersion: z.literal(FLOW_AGGREGATION_VERSION),
  origin: z.enum(["local", "import"]),
  coverage: z.strictObject({
    firstAt: z.number().int().nonnegative(), lastAt: z.number().int().nonnegative(),
    activeDays: z.number().int().nonnegative(), sessions: z.number().int().nonnegative(),
    exposures: z.number().int().nonnegative(), droppedEvents: z.number().int().nonnegative(), gaps: z.number().int().nonnegative(),
  }),
  heat: z.array(heat).max(512),
  flows: z.array(z.strictObject({ fromControlId: id, toControlId: id, count: z.number().int().positive() })).max(1024),
  friction: z.array(z.strictObject({ controlId: id, abandoned: z.number().int().nonnegative(), failures: z.number().int().nonnegative(), backtracks: z.number().int().nonnegative(), loops: z.number().int().nonnegative() })).max(512),
  expectations: z.array(z.strictObject({
    id: z.string().min(1).max(400), pattern: z.enum(["placement", "discoverability", "missing-capability"]),
    areaId: id, destinationControlId: id.optional(), occurrences: z.number().int().nonnegative(),
    coverage: z.number().min(0).max(1), confidence: z.number().min(0).max(1), state: z.enum(["unconfirmed", "confirmed", "rejected"]),
  })).max(128),
});
const placement = z.strictObject({ anchorId: id, areaId: id, order: z.number().int().nonnegative(), visible: z.boolean(), variant: z.enum(["compact", "default", "expanded"]), pinned: z.boolean(), origin: z.enum(["user", "product", "fallback"]), operationId: id.optional() });
const documentWithoutChecksum = z.strictObject({
  format: z.literal("flowmap"),
  version: z.literal(FLOW_MAP_VERSION),
  generatedAt: z.number().int().nonnegative(),
  scope: workspaceInputSchemas.scope,
  view: z.enum(["heat", "flow", "friction", "expectation"]),
  evidence,
  catalog: z.strictObject({
    catalogVersion: z.string().min(1).max(64),
    areas: z.array(z.strictObject({ id, surfaceId: workspaceInputSchemas.scope.shape.surfaceId, role: z.enum(["actions", "navigation", "primary", "secondary", "overlay", "dock"]), capacity: z.number().int().positive(), allowedAnchorIds: z.array(id).max(128).readonly() })).max(128),
    anchors: z.array(z.strictObject({ id, surfaceId: workspaceInputSchemas.scope.shape.surfaceId, renderer: z.string().min(1).max(128), semanticRevision: z.number().int().positive() })).max(512),
    controls: z.array(z.strictObject({ id, anchorId: id, kind: z.enum(["command", "navigation", "mutation", "toggle", "disclosure", "input"]), semanticRevision: z.number().int().positive() })).max(2048),
    tombstones: z.array(z.strictObject({ anchorId: id, replacementAnchorId: id.optional(), fallback: z.enum(["isolate", "conflict"]) })).max(128),
  }),
  workspace: z.strictObject({ placements: z.array(placement).max(128), catalogVersion: z.string().min(1).max(64), productDefaultVersion: z.string().min(1).max(64), resolverVersion: z.literal(1) }),
  svg: z.string().min(1).max(300_000),
});
export const flowMapDocumentSchema = documentWithoutChecksum.extend({ checksum: z.string().regex(/^[0-9a-f]{64}$/) });
export const flowEventSchema = event;
export const flowEventBatchSchema = z.strictObject({ events: z.array(event).min(1).max(50) });
export const flowEvidenceSchema = evidence;

const allowedSvgTags = new Set(["svg", "g", "rect", "circle", "path", "line", "polyline", "polygon", "text", "tspan", "title", "desc"]);
export function assertStaticSvg(svg: string): void {
  if (/<(?:script|foreignObject|image|use|iframe|object|embed|set|animate)\b|\son[a-z]+\s*=|\b(?:href|src|style)\s*=|url\s*\(|@import|javascript\s*:|<!DOCTYPE|<\?xml/i.test(svg)) {
    throw new Error("FlowMap SVG contains active or external content");
  }
  for (const match of svg.matchAll(/<\/?([A-Za-z][\w-]*)/g)) {
    if (!allowedSvgTags.has(match[1])) throw new Error(`Unsupported SVG element ${match[1]}`);
  }
}
