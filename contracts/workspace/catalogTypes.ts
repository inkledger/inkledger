import type {
  AnchorDefinition,
  AreaDefinition,
  Catalog,
  DeviceClass,
  Scope,
  SurfaceId,
  Variant,
} from "./model";
import type { RESOLVER_VERSION } from "./versions";

export type ControlKind = "navigation" | "command" | "mutation" | "toggle" | "disclosure" | "input" | "destructive";
export type InteractionKind = "activate" | "navigate" | "succeed" | "fail" | "expose" | "search-open" | "search-select" | "search-abandon" | "layout" | "discovery";
export type A11yRole = "button" | "link" | "checkbox" | "switch" | "radio" | "tab" | "textbox" | "combobox" | "menuitem" | "slider" | "region";

export type ControlInteraction = {
  eventId: string;
  kind: InteractionKind;
  telemetry: "allowed" | "disabled";
};

export type AccessibilityContract = {
  role: A11yRole;
  labelKey: string;
  keyboard: "activation" | "navigation" | "input" | "not-applicable";
  minTouchTargetPx: 24 | 44;
  textAlternativeKey?: string;
};

export type ControlDefinition = {
  id: string;
  anchorId: string;
  kind: ControlKind;
  critical: boolean;
  sensitive: boolean;
  introducedIn: string;
  semanticRevision: number;
  accessibility: AccessibilityContract;
  interactions: readonly ControlInteraction[];
};

export type StudioMetadata = {
  operations: readonly ("move" | "reorder" | "variant" | "hide" | "pin")[];
  variants: readonly Variant[];
  descriptionKey: string;
};

export type AnchorManifest = AnchorDefinition & {
  surfaceId: SurfaceId;
  semanticRevision: number;
  studio: StudioMetadata;
  accessibility: AccessibilityContract;
};

export type AreaManifest = AreaDefinition & {
  surfaceId: SurfaceId;
  role: "navigation" | "actions" | "primary" | "secondary" | "overlay" | "dock";
  introducedIn: string;
};

export type SurfaceDefinition = {
  id: SurfaceId;
  route: "/" | "*";
  deviceClasses: readonly DeviceClass[];
};

export type RendererBindingDefinition = {
  anchorId: string;
  kind: "core" | "addon";
  renderer: string;
};

export type CatalogManifest = Omit<Catalog, "areas" | "anchors"> & {
  schemaVersion: 1;
  resolverVersion: typeof RESOLVER_VERSION;
  surfaces: readonly SurfaceDefinition[];
  areas: readonly AreaManifest[];
  anchors: readonly AnchorManifest[];
  controls: readonly ControlDefinition[];
  rendererBindings: readonly RendererBindingDefinition[];
};

export type CatalogDiff = {
  addedAreaIds: readonly string[];
  removedAreaIds: readonly string[];
  addedAnchorIds: readonly string[];
  removedAnchorIds: readonly string[];
  semanticAnchorIds: readonly string[];
  addedControlIds: readonly string[];
  removedControlIds: readonly string[];
  semanticControlIds: readonly string[];
  productDefaultChanged: boolean;
};

export type ScopeDefaults = Readonly<Partial<Record<SurfaceId, {
  productDefaultVersion: string;
  placements: readonly {
    anchorId: string;
    areaId: string;
    order: number;
    visible: boolean;
    variant: Variant;
    pinned: boolean;
  }[];
}>>>;

export type ScopeWithCatalog = Scope & { surfaceId: SurfaceId };
