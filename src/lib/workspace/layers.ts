import type { FlowModality, FlowTransition, FrictionPoint, HeatPoint } from "@contracts/workspace/flowMap";

/**
 * The Layout view draws one page and lays what is known about it over it, layer by layer:
 * - `edit`: the handles, eyes, pins and menus that change it;
 * - `use`: how much each block was used, and where in it the clicks landed;
 * - `paths`: arrows from a block to the one used next;
 * - `friction`: an outline where use went wrong (left halfway, failed, back and forth);
 * - `news`: what the latest version added.
 */
export const LAYERS = ["edit", "use", "paths", "friction", "news"] as const;
export type Layer = (typeof LAYERS)[number];
/** The layers drawn from usage collection (FlowMap): they need it on, and a period to read. */
export const DATA_LAYERS: readonly Layer[] = ["use", "paths", "friction"];

/** What this device remembers: the layers chosen, and the period chosen per part of the app. */
export type LayerView = { layers: readonly Layer[]; periods: Readonly<Record<string, string>> };
export const DEFAULT_VIEW: LayerView = { layers: ["edit", "news"], periods: {} };

const isLayer = (value: unknown): value is Layer => typeof value === "string" && (LAYERS as readonly string[]).includes(value);

export function parseLayerView(raw: string | null): LayerView {
  if (raw === null) return DEFAULT_VIEW;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_VIEW;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_VIEW;
  const layers: unknown = "layers" in parsed ? parsed.layers : undefined;
  const periods: unknown = "periods" in parsed ? parsed.periods : undefined;
  return {
    layers: Array.isArray(layers) ? LAYERS.filter(layer => layers.some(item => item === layer && isLayer(item))) : DEFAULT_VIEW.layers,
    periods: typeof periods === "object" && periods !== null
      ? Object.fromEntries(Object.entries(periods).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {},
  };
}

export const formatLayerView = (view: LayerView): string => JSON.stringify(view);

/** One layer on or off; the others as they were, always in the toolbar's order. */
export function toggleLayer(view: LayerView, layer: Layer): LayerView {
  const on = view.layers.includes(layer);
  return { ...view, layers: LAYERS.filter(item => item === layer ? !on : view.layers.includes(item)) };
}

export type LayerReason = "collectionOff" | "noData" | "nothingNew";
export type LayerState = { available: boolean; reason: LayerReason | null };

/** Which layers can be drawn now, and if not why: collection off, nothing in the period, nothing new. */
export function layerStates({ collecting, hasUse, hasPaths, hasFriction, news }: { collecting: boolean; hasUse: boolean; hasPaths: boolean; hasFriction: boolean; news: number }): Record<Layer, LayerState> {
  const data = (has: boolean): LayerState => !collecting ? { available: false, reason: "collectionOff" } : has ? { available: true, reason: null } : { available: false, reason: "noData" };
  return {
    edit: { available: true, reason: null },
    use: data(hasUse),
    paths: data(hasPaths),
    friction: data(hasFriction),
    news: news > 0 ? { available: true, reason: null } : { available: false, reason: "nothingNew" },
  };
}

/** The chosen layers that can be drawn. */
export function shownLayers(chosen: readonly Layer[], states: Record<Layer, LayerState>): ReadonlySet<Layer> {
  return new Set(LAYERS.filter(layer => chosen.includes(layer) && states[layer].available));
}

/** A way from one block of this page to the next one used: `to` null when it leads off this page. */
export type BlockPath = { from: string; to: string | null; toControlId: string; count: number };

/**
 * The page's paths, block to block: the controls' transitions added up per pair of blocks, moves inside
 * one block left out, the busiest first. A path starts on this page; one leading elsewhere keeps the
 * control it reaches, for its name.
 */
export function pathsOf(flows: readonly FlowTransition[], anchorOf: (controlId: string) => string | undefined, onPage: (anchorId: string) => boolean, limit = Number.POSITIVE_INFINITY): BlockPath[] {
  const paths = new Map<string, BlockPath>();
  for (const flow of flows) {
    const from = anchorOf(flow.fromControlId);
    const target = anchorOf(flow.toControlId);
    if (!from || !target || from === target || !onPage(from)) continue;
    const to = onPage(target) ? target : null;
    const key = `${from}>${to ?? `control:${flow.toControlId}`}`;
    const known = paths.get(key);
    paths.set(key, known ? { ...known, count: known.count + flow.count } : { from, to, toControlId: flow.toControlId, count: flow.count });
  }
  return [...paths.values()]
    .sort((a, b) => b.count - a.count || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || ((a.to ?? a.toControlId) < (b.to ?? b.toControlId) ? -1 : 1))
    .slice(0, limit);
}

/** A block's paths: where it leads, and where it is reached from (the busiest three of each). */
export function pathsAround(paths: readonly BlockPath[], anchorId: string, limit = 3): { out: BlockPath[]; in: BlockPath[] } {
  return {
    out: paths.filter(path => path.from === anchorId).slice(0, limit),
    in: paths.filter(path => path.to === anchorId).slice(0, limit),
  };
}

export type BlockFriction = { abandoned: number; failures: number; backtracks: number; loops: number; total: number };

/** Where use went wrong, per block: its controls' trouble added up; a block without any is left out. */
export function frictionByAnchor(friction: readonly FrictionPoint[], anchorOf: (controlId: string) => string | undefined): Map<string, BlockFriction> {
  const byAnchor = new Map<string, BlockFriction>();
  for (const point of friction) {
    const anchorId = anchorOf(point.controlId);
    const total = point.abandoned + point.failures + point.backtracks + point.loops;
    if (!anchorId || total <= 0) continue;
    const known = byAnchor.get(anchorId) ?? { abandoned: 0, failures: 0, backtracks: 0, loops: 0, total: 0 };
    byAnchor.set(anchorId, {
      abandoned: known.abandoned + point.abandoned,
      failures: known.failures + point.failures,
      backtracks: known.backtracks + point.backtracks,
      loops: known.loops + point.loops,
      total: known.total + total,
    });
  }
  return byAnchor;
}

export type BlockUse = { clicks: number; seen: number; modalities: Record<FlowModality, number> };

/**
 * One block's use: its controls' clicks added up, how (mouse, touch, keys), and how often it was seen
 * (its most seen control: the block is on screen whenever any of them is).
 */
export function blockUse(heat: readonly HeatPoint[], anchorId: string): BlockUse {
  const modalities: Record<FlowModality, number> = { pointer: 0, touch: 0, keyboard: 0, unknown: 0 };
  let clicks = 0;
  let seen = 0;
  for (const point of heat) {
    if (point.anchorId !== anchorId) continue;
    clicks += point.activations;
    seen = Math.max(seen, point.exposures);
    for (const modality of ["pointer", "touch", "keyboard", "unknown"] as const) modalities[modality] += point.modalities[modality];
  }
  return { clicks, seen, modalities };
}
