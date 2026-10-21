import type { SurfaceCatalog, SurfaceProfile } from "@/modules/types";

/**
 * The surfaces of the interface (UIX): which elements may take an effect
 * such as a shadow, how high each kind may stand, its real outline, and what
 * would be wrong on it. It belongs to the app and exists with or without any
 * module; a module that draws effects (Shadow) reads it through
 * host.surfaces and never guesses from the DOM.
 *
 * Components mark themselves with `surface(kind, …)`, never by hand (lint:
 * scripts/check-design.mjs), so a new page joins the catalog by using it.
 */
export const SURFACES = {
  control: {
    about: "A button, switch, segmented option or nav box standing on the page",
    cast: true,
    maxElevation: 1,
    shape: "rect",
    effects: ["cast", "contact", "edge"],
    translucent: false,
    bakedShadow: false,
    floating: false,
    cost: "low",
  },
  chip: {
    about: "A chip, badge or count pill",
    cast: true,
    maxElevation: 1,
    shape: "pill",
    effects: ["cast", "contact", "edge"],
    translucent: false,
    bakedShadow: false,
    floating: false,
    cost: "low",
  },
  picture: {
    about: "An avatar, project picture or mark: its own silhouette, not its box",
    cast: true,
    maxElevation: 1,
    shape: "alpha",
    effects: ["cast"],
    translucent: false,
    bakedShadow: false,
    floating: false,
    cost: "low",
  },
  note: {
    about: "A paper note on the pinboard: its curled-paper shadow is part of the drawing, so nothing adds another",
    cast: true,
    maxElevation: 1,
    shape: "rect",
    effects: [],
    translucent: false,
    bakedShadow: true,
    floating: false,
    cost: "low",
  },
  bar: {
    about: "A data bar, block or meter on a chart or timeline",
    cast: true,
    maxElevation: 1,
    shape: "rect",
    effects: ["cast", "contact", "edge"],
    translucent: false,
    bakedShadow: false,
    floating: false,
    cost: "medium",
  },
  card: {
    about: "A card or a group of controls",
    cast: true,
    maxElevation: 2,
    shape: "rect",
    effects: ["cast", "contact", "edge"],
    translucent: false,
    bakedShadow: false,
    floating: false,
    cost: "medium",
  },
  panel: {
    about: "The main panel over the page",
    cast: true,
    maxElevation: 3,
    shape: "rect",
    effects: ["cast"],
    translucent: false,
    bakedShadow: false,
    floating: false,
    cost: "high",
  },
  nav: {
    about: "A navigation item: stands out only while it is the current page",
    cast: true,
    maxElevation: 1,
    shape: "rect",
    effects: ["cast"],
    translucent: false,
    bakedShadow: false,
    floating: false,
    cost: "low",
  },
  menu: {
    about: "A menu, popover or list floating over the page",
    cast: true,
    maxElevation: 3,
    shape: "rect",
    effects: ["cast", "edge"],
    translucent: false,
    bakedShadow: false,
    floating: true,
    cost: "low",
  },
  dialog: {
    about: "A dialog or sheet floating over the page",
    cast: true,
    maxElevation: 3,
    shape: "rect",
    effects: ["cast", "edge"],
    translucent: false,
    bakedShadow: false,
    floating: true,
    cost: "medium",
  },
  ground: {
    about: "What surfaces stand on (a sidebar, a chart's track): receives shadows, casts none",
    cast: false,
    maxElevation: 0,
    shape: "rect",
    effects: [],
    translucent: false,
    bakedShadow: false,
    floating: false,
    cost: "low",
  },
  glass: {
    about: "See-through by design (blurred headers, live stripes, placeholders): no cast shadow, it would show as a box",
    cast: false,
    maxElevation: 0,
    shape: "rect",
    effects: [],
    translucent: true,
    bakedShadow: false,
    floating: false,
    cost: "low",
  },
} as const satisfies SurfaceCatalog;

export type SurfaceKind = keyof typeof SURFACES;

type Upto<N> = N extends 3 ? 1 | 2 | 3 : N extends 2 ? 1 | 2 : N extends 1 ? 1 : never;
/** The elevations a kind allows (none for one that never stands out). */
export type ElevationOf<K extends SurfaceKind> = Upto<(typeof SURFACES)[K]["maxElevation"]>;

type SurfaceAttrs = {
  "data-surface"?: SurfaceKind;
  "data-elev"?: string;
  "data-surface-role"?: "wrap" | "face";
  "data-surface-edge"?: "off";
  "data-surface-current"?: "";
};

/**
 * The attributes that mark an element as a surface of `kind`. `elevation`
 * defaults to the kind's lowest (1); `on: false` marks nothing (a surface
 * that stands out only sometimes); `role`: "wrap" around a `face` that clips.
 */
export function surface<K extends SurfaceKind>(
  kind: K,
  o: { elevation?: ElevationOf<K>; role?: "wrap" | "face"; edge?: boolean; current?: boolean; on?: boolean } = {},
): SurfaceAttrs {
  if (o.on === false) return {};
  const max = (SURFACES[kind] as SurfaceProfile).maxElevation;
  return {
    "data-surface": kind,
    ...(max > 0 && o.role !== "face" ? { "data-elev": String(o.elevation ?? 1) } : {}),
    ...(o.role ? { "data-surface-role": o.role } : {}),
    ...(o.edge === false ? { "data-surface-edge": "off" as const } : {}),
    ...(o.current ? { "data-surface-current": "" as const } : {}),
  };
}

/** The face of a wrap: the visible top that clips (its wrap casts the shadow). */
export const surfaceFace = (o: { edge?: boolean; on?: boolean } = {}): SurfaceAttrs =>
  o.on === false ? {} : { "data-surface-role": "face", ...(o.edge === false ? { "data-surface-edge": "off" as const } : {}) };
