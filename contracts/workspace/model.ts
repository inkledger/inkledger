import type { OpaqueEntry } from "./opaque";
import type {
  CANONICALIZATION_VERSION,
  FINGERPRINT_FIELDS_VERSION,
  RESOLVER_VERSION,
} from "./versions";

export type SurfaceId = "dashboard" | "shell-desktop" | "mobile-tabs";
export type DeviceClass = "desktop" | "mobile";
export type Scope = { surfaceId: SurfaceId; deviceClass: DeviceClass };
export type StatePolicy = "stateless" | "external" | "local" | "dirty" | "critical";
export type Variant = "compact" | "default" | "expanded";

export type AreaDefinition = {
  id: string;
  surfaceId?: SurfaceId;
  capacity: number;
  allowedAnchorIds: readonly string[];
  introducedIn?: string;
};

export type AnchorDefinition = {
  id: string;
  surfaceId: SurfaceId;
  renderer: string;
  statePolicy: StatePolicy;
  critical: boolean;
  introducedIn: string;
  studio?: { operations: readonly ("move" | "reorder" | "variant" | "hide" | "pin")[] };
};

export type Tombstone = {
  anchorId: string;
  replacementAnchorId?: string;
  fallback: "isolate" | "conflict";
};

export type ProductMigration = {
  id: string;
  fromCatalogVersion: string;
  toCatalogVersion: string;
  anchorId: string;
  fallback: { type: "move"; toAreaId: string } | { type: "isolate" };
};

export type Catalog = {
  catalogVersion: string;
  productDefaultVersion: string;
  resolverVersion: typeof RESOLVER_VERSION;
  areas: readonly AreaDefinition[];
  anchors: readonly AnchorDefinition[];
  tombstones: readonly Tombstone[];
};

export type Placement = {
  anchorId: string;
  areaId: string;
  order: number;
  visible: boolean;
  variant: Variant;
  pinned: boolean;
};

export type ProductDefault = {
  productDefaultVersion: string;
  placements: readonly Placement[];
};

export type LayoutOperation =
  | { type: "move"; operationId: string; anchorId: string; toAreaId: string; order?: number }
  | { type: "reorder"; operationId: string; areaId: string; anchorIds: readonly string[] }
  | { type: "variant"; operationId: string; anchorId: string; variant: Variant }
  | { type: "visibility"; operationId: string; anchorId: string; visible: boolean }
  | { type: "pin"; operationId: string; anchorId: string; pinned: boolean };

export type SuggestionAuthor = "user" | "deterministic" | "AI" | "import";
export type OperationOrigin = SuggestionAuthor | "product";
export type IntentKind = "prioritize" | "reduce" | "group" | "expectHere" | "keepVisible" | "custom";

export type Intent = {
  kind: IntentKind;
  status: "proposed" | "explicit";
  anchorId?: string;
  areaId?: string;
};

export type Constraint = {
  id: string;
  kind: "pin" | "hide" | "keepVisible" | "expectHere" | "doNotSuggest";
  status: "proposed" | "explicit";
  author: SuggestionAuthor;
  scope: Scope;
  anchorId: string;
  areaId?: string;
};

export type PatchProvenance = {
  parentPatchId?: string;
  model?: string;
  modelVersion?: string;
  importSource?: string;
};

export type SuggestionPatch = {
  patchId: string;
  patchSchemaVersion: number;
  scope: Scope;
  baseRevision: string;
  catalogVersion: string;
  author: SuggestionAuthor;
  provenance: PatchProvenance;
  intent: Intent;
  operations: readonly LayoutOperation[];
  evidence: readonly { evidenceId: string; effectiveRevision: string }[];
  proposedConstraints: readonly Constraint[];
  revokedConstraintIds?: readonly string[];
  expectedOutcome?: string;
  suggestionSignature?: string;
  causalParentRevision?: string;
};

export type CommittedOperation = {
  operation: LayoutOperation;
  origin: OperationOrigin;
  acceptedByUser: boolean;
  patchId?: string;
};

export type ActiveRevision = {
  revisionId: string;
  scope: Scope;
  catalogVersion: string;
  productDefaultVersion: string;
  committedAt: number;
  operations: readonly CommittedOperation[];
  constraints: readonly Constraint[];
  causedByRevision?: string;
  opaque: readonly OpaqueEntry[];
};

export type DraftStatus = "editing" | "ready" | "conflict" | "stale" | "applying" | "applied" | "aborted" | "discarded";

export type Draft = {
  draftId: string;
  draftRevision: number;
  baseRevision: string;
  scope: Scope;
  patches: readonly SuggestionPatch[];
  status: DraftStatus;
};

export type FeedbackState = {
  suppressedSuggestionSignatures: readonly string[];
};

export type DiscoveryState = {
  seenAnchorIds: readonly string[];
  placedAnchorIds: readonly string[];
  dismissedAnchorIds: readonly string[];
  seenAreaIds?: readonly string[];
  placedAreaIds?: readonly string[];
  dismissedAreaIds?: readonly string[];
};

export type ResolvedPlacement = Placement & {
  origin: "user" | "product" | "fallback";
  operationId?: string;
};

export type ResolvedFallback = {
  anchorId: string;
  reason: "replaced" | "isolated" | "migrated";
  replacementAnchorId?: string;
  migrationId?: string;
  fromAreaId?: string;
  toAreaId?: string;
};

export type ResolvedWorkspace = {
  scope: Scope;
  sourceActiveRevision: string;
  catalogVersion: string;
  productDefaultVersion: string;
  resolverVersion: typeof RESOLVER_VERSION;
  placements: readonly ResolvedPlacement[];
  fallbacks: readonly ResolvedFallback[];
  discoveryAnchorIds: readonly string[];
  discoveryAreaIds: readonly string[];
  opaque: readonly OpaqueEntry[];
};

export type WorkspaceConflict = {
  code:
    | "unknown-anchor"
    | "unknown-area"
    | "incompatible-area"
    | "area-capacity"
    | "critical-hidden"
    | "constraint-conflict"
    | "suggestion-suppressed"
    | "unknown-content-write";
  anchorId?: string;
  areaId?: string;
  detail: string;
};

export type ConflictSet = {
  kind: "conflicts";
  conflicts: readonly WorkspaceConflict[];
};

export type ResolveResult =
  | { kind: "resolved"; workspace: ResolvedWorkspace }
  | ConflictSet;

export type PresentationDescriptor = {
  effectiveRevision: string;
  sourceActiveRevision: string;
  workspaceFingerprint: string;
  productDefaultVersion: string;
  catalogVersion: string;
  resolverVersion: typeof RESOLVER_VERSION;
  constraintsFingerprint: string;
  feedbackFingerprint: string;
  discoveryFingerprint: string;
  rendererBindingsFingerprint: string;
};

export type FingerprintDescriptor = {
  canonicalizationVersion: typeof CANONICALIZATION_VERSION;
  fingerprintAlgorithm: "SHA-256";
  fieldsVersion: typeof FINGERPRINT_FIELDS_VERSION;
  value: string;
};

export type ResolveInput = {
  catalog: Catalog;
  productDefault: ProductDefault;
  activeRevision: ActiveRevision;
  draft: Draft | null;
  explicitConstraints: readonly Constraint[];
  feedback: FeedbackState;
  discoveryState: DiscoveryState;
  migrations?: readonly ProductMigration[];
};
