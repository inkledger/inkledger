import { sha256Hex } from "../lib/hash";
import { z } from "zod";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import { assertOpaqueEntries, base64UrlToBytes } from "@contracts/workspace/opaque";

/** Ids and short labels: bounded, so a request cannot make resolve or storage work on megabytes (D-28). */
const id = z.string().min(1).max(128);
const text = z.string().max(500);

const scopeSchema = z.strictObject({
  surfaceId: z.enum(["dashboard", "shell-desktop", "mobile-tabs"]),
  deviceClass: z.enum(["desktop", "mobile"]),
}).refine(
  value => CATALOG_V1.surfaces.some(surface => surface.id === value.surfaceId && surface.deviceClasses.includes(value.deviceClass)),
  { message: "Unsupported workspace scope" },
);
const statePolicySchema = z.enum(["stateless", "external", "local", "dirty", "critical"]);
const variantSchema = z.enum(["compact", "default", "expanded"]);
const authorSchema = z.enum(["user", "deterministic", "AI", "import"]);
const intentSchema = z.strictObject({
  kind: z.enum(["prioritize", "reduce", "group", "expectHere", "keepVisible", "custom"]),
  status: z.enum(["proposed", "explicit"]),
  anchorId: id.optional(),
  areaId: id.optional(),
});
const constraintSchema = z.strictObject({
  id: id,
  kind: z.enum(["pin", "hide", "keepVisible", "expectHere", "doNotSuggest"]),
  status: z.enum(["proposed", "explicit"]),
  author: authorSchema,
  scope: scopeSchema,
  anchorId: id,
  areaId: id.optional(),
});
const operationSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("move"), operationId: id, anchorId: id, toAreaId: id, order: z.number().int().optional() }),
  z.strictObject({ type: z.literal("reorder"), operationId: id, areaId: id, anchorIds: z.array(id).max(64).readonly() }),
  z.strictObject({ type: z.literal("variant"), operationId: id, anchorId: id, variant: variantSchema }),
  z.strictObject({ type: z.literal("visibility"), operationId: id, anchorId: id, visible: z.boolean() }),
  z.strictObject({ type: z.literal("pin"), operationId: id, anchorId: id, pinned: z.boolean() }),
]);
const opaqueEntrySchema = z.strictObject({
  version: z.literal(1),
  entryType: id,
  schemaVersion: z.number().int().positive(),
  payloadBase64url: z.string().max(22_000).regex(/^[A-Za-z0-9_-]*$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteLength: z.number().int().nonnegative(),
});
/** Unknown future content: within the D-28 limits, and each payload really is what its digest says. */
const opaqueSchema = z.array(opaqueEntrySchema).max(32).readonly().superRefine((entries, ctx) => {
  try {
    assertOpaqueEntries(entries);
    for (const entry of entries) {
      if (sha256Hex(base64UrlToBytes(entry.payloadBase64url)) !== entry.sha256) throw new Error("opaque v1: digest mismatch");
    }
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "opaque v1: invalid" });
  }
});
const patchSchema = z.strictObject({
  patchId: id,
  patchSchemaVersion: z.number().int().positive(),
  scope: scopeSchema,
  baseRevision: id,
  catalogVersion: id,
  author: authorSchema,
  provenance: z.strictObject({
    parentPatchId: id.optional(),
    model: id.optional(),
    modelVersion: id.optional(),
    importSource: id.optional(),
  }),
  intent: intentSchema,
  operations: z.array(operationSchema).max(32).readonly(),
  evidence: z.array(z.strictObject({ evidenceId: id, effectiveRevision: id })).max(32).readonly(),
  proposedConstraints: z.array(constraintSchema).max(32).readonly(),
  revokedConstraintIds: z.array(id).max(32).readonly().optional(),
  expectedOutcome: text.optional(),
  suggestionSignature: id.optional(),
  causalParentRevision: id.optional(),
});
const committedOperationSchema = z.strictObject({
  operation: operationSchema,
  origin: z.enum(["user", "deterministic", "AI", "import", "product"]),
  acceptedByUser: z.boolean(),
  patchId: id.optional(),
});
const descriptorSchema = z.strictObject({
  effectiveRevision: id,
  sourceActiveRevision: id,
  workspaceFingerprint: id,
  productDefaultVersion: id,
  catalogVersion: id,
  resolverVersion: z.literal(1),
  constraintsFingerprint: id,
  feedbackFingerprint: id,
  discoveryFingerprint: id,
  rendererBindingsFingerprint: id,
});

export const activeRevisionSchema = z.strictObject({
  revisionId: id,
  scope: scopeSchema,
  catalogVersion: id,
  productDefaultVersion: id,
  committedAt: z.number().int(),
  operations: z.array(committedOperationSchema).readonly(),
  constraints: z.array(constraintSchema).readonly(),
  causedByRevision: id.optional(),
  opaque: opaqueSchema,
});

export const draftSchema = z.strictObject({
  draftId: id,
  draftRevision: z.number().int().positive(),
  baseRevision: id,
  scope: scopeSchema,
  patches: z.array(patchSchema).max(32).readonly(),
  status: z.enum(["editing", "ready", "conflict", "stale", "applying", "applied", "aborted", "discarded"]),
});

export const presentationDescriptorSchema = descriptorSchema;
export const presentationStateSchema = z.strictObject({
  clientInstanceId: id,
  status: z.enum(["stable", "pendingActivation", "activationUncertain", "unknown"]),
  lastIssuedEpoch: z.number().int().nonnegative(),
  presented: z.strictObject({ descriptor: descriptorSchema, presentationEpoch: z.number().int().positive() }).optional(),
  pending: z.strictObject({
    leaseId: id,
    leaseTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    leaseExpiresAt: z.number().int(),
    activationId: id.optional(),
    activationExpiresAt: z.number().int().optional(),
    descriptor: descriptorSchema,
    draftRevision: z.number().int().positive(),
    interactionEpoch: z.number().int().nonnegative(),
    presentationEpoch: z.number().int().positive(),
  }).optional(),
});
export const preparedRevisionSchema = z.strictObject({
  prepareId: id,
  clientInstanceId: id,
  baseRevision: id,
  draftRevision: z.number().int().positive(),
  interactionEpoch: z.number().int().nonnegative(),
  descriptor: descriptorSchema,
  expiresAt: z.number().int(),
});

export const workspaceInputSchemas = {
  scope: scopeSchema,
  activeRevision: activeRevisionSchema,
  draft: draftSchema,
  descriptor: descriptorSchema,
  presentation: presentationStateSchema,
  prepared: preparedRevisionSchema,
  statePolicy: statePolicySchema,
  variant: variantSchema,
};

export type ValidatedScope = z.infer<typeof scopeSchema>;
export type ValidatedActiveRevision = z.infer<typeof activeRevisionSchema>;
export type ValidatedDraft = z.infer<typeof draftSchema>;
export type ValidatedDescriptor = z.infer<typeof descriptorSchema>;
export type ValidatedPresentation = z.infer<typeof presentationStateSchema>;
export type ValidatedPrepared = z.infer<typeof preparedRevisionSchema>;
