import { z } from "zod";

/**
 * The Desk: up to four issues side by side, laid out like windows snapped on a desktop. A layout is
 * one of a few fixed arrangements (halves, thirds, one big and two, quarters) with the size of each
 * of its columns and rows; slot i of the arrangement holds pane i. Pure: shared by the page and
 * the server, which stores the desk.
 */

export const DESK_MAX_PANES = 4;
export const DESK_MAX_PARKED = 8;
export const DESK_SAVED_MAX = 50;
/** The smallest share of the desk a column or row may take. */
export const MIN_TRACK = 0.15;

export const PRESET_IDS = ["single", "cols-2", "rows-2", "cols-3", "cols-4", "main-left", "main-right", "main-top", "main-bottom", "quad"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** Each cell of the grid names the slot (0-based) that covers it. */
export type Preset = { id: PresetId; slots: number; areas: readonly (readonly number[])[] };

export const PRESETS: Record<PresetId, Preset> = {
  single: { id: "single", slots: 1, areas: [[0]] },
  "cols-2": { id: "cols-2", slots: 2, areas: [[0, 1]] },
  "rows-2": { id: "rows-2", slots: 2, areas: [[0], [1]] },
  "cols-3": { id: "cols-3", slots: 3, areas: [[0, 1, 2]] },
  "cols-4": { id: "cols-4", slots: 4, areas: [[0, 1, 2, 3]] },
  "main-left": { id: "main-left", slots: 3, areas: [[0, 1], [0, 2]] },
  "main-right": { id: "main-right", slots: 3, areas: [[1, 0], [2, 0]] },
  "main-top": { id: "main-top", slots: 3, areas: [[0, 0], [1, 2]] },
  "main-bottom": { id: "main-bottom", slots: 3, areas: [[1, 2], [0, 0]] },
  quad: { id: "quad", slots: 4, areas: [[0, 1], [2, 3]] },
};

/** The arrangements for a number of panes, in the order they are offered. */
export function presetsFor(n: number): PresetId[] {
  return PRESET_IDS.filter(id => PRESETS[id].slots === n);
}

const DEFAULT_FOR: Record<number, PresetId> = { 0: "single", 1: "single", 2: "cols-2", 3: "main-left", 4: "quad" };
export const defaultPreset = (n: number): PresetId => DEFAULT_FOR[Math.min(Math.max(n, 0), DESK_MAX_PANES)];

export type Tracks = { cols: number[]; rows: number[] };

const even = (count: number) => Array.from({ length: count }, () => 1 / count);
export const defaultTracks = (id: PresetId): Tracks => ({ cols: even(PRESETS[id].areas[0].length), rows: even(PRESETS[id].areas.length) });

export const deskPaneSchema = z.object({
  connectionId: z.number().int().positive(),
  key: z.string().min(1).max(100),
  remoteId: z.string().max(200).nullable(),
});
export type DeskPane = z.infer<typeof deskPaneSchema>;

const tracksSchema = z.object({ cols: z.array(z.number()).max(4), rows: z.array(z.number()).max(4) });

export const deskLayoutSchema = z.object({
  v: z.literal(1),
  preset: z.enum(PRESET_IDS),
  tracks: z.record(z.string(), tracksSchema),
  panes: z.array(deskPaneSchema).max(20),
  parked: z.array(deskPaneSchema).max(40),
  maximized: z.string().nullable(),
  compare: z.boolean(),
  onlyDifferences: z.boolean(),
  noteId: z.uuid().nullable(),
});
export type DeskLayout = Omit<z.infer<typeof deskLayoutSchema>, "tracks"> & { tracks: Partial<Record<PresetId, Tracks>> };

export const paneId = (pane: Pick<DeskPane, "connectionId" | "key">) => `${pane.connectionId}:${pane.key}`;

export const emptyDesk = (): DeskLayout => ({ v: 1, preset: "single", tracks: {}, panes: [], parked: [], maximized: null, compare: false, onlyDifferences: false, noteId: null });

/** Shares that add up to 1, none under MIN_TRACK; null when they can't be read as such. */
function cleanTracks(values: readonly number[], count: number): number[] | null {
  if (values.length !== count || values.some(value => !Number.isFinite(value) || value <= 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  let shares = values.map(value => value / total);
  // Raising the small ones takes from the others in proportion: at most a few rounds for four tracks.
  for (let round = 0; round < count && shares.some(share => share < MIN_TRACK - 1e-9); round++) {
    const low = shares.map(share => share < MIN_TRACK);
    const needed = shares.reduce((sum, share, i) => sum + (low[i] ? MIN_TRACK - share : 0), 0);
    const spare = shares.reduce((sum, share, i) => sum + (low[i] ? 0 : share - MIN_TRACK), 0);
    if (spare <= 0) return even(count);
    shares = shares.map((share, i) => (low[i] ? MIN_TRACK : share - (needed * (share - MIN_TRACK)) / spare));
  }
  return shares;
}

/**
 * Any stored or sent desk made safe to draw: unknown fields and arrangements dropped, the same issue
 * never twice, at most four panes (the rest parked) and eight parked, an arrangement that has as many
 * slots as panes, sizes that add up and none too thin.
 */
export function normalizeDesk(raw: unknown): DeskLayout {
  const parsed = deskLayoutSchema.safeParse(raw);
  if (!parsed.success) return emptyDesk();
  const value = parsed.data;
  const seen = new Set<string>();
  const unique = (panes: readonly DeskPane[]) => panes.filter(pane => !seen.has(paneId(pane)) && seen.add(paneId(pane)));
  const shown = unique(value.panes);
  const panes = shown.slice(0, DESK_MAX_PANES);
  const parked = [...shown.slice(DESK_MAX_PANES), ...unique(value.parked)].slice(0, DESK_MAX_PARKED);
  const preset = PRESETS[value.preset].slots === Math.max(panes.length, 1) ? value.preset : defaultPreset(panes.length);
  const tracks: Partial<Record<PresetId, Tracks>> = {};
  for (const id of PRESET_IDS) {
    const stored = value.tracks[id];
    if (!stored) continue;
    const cols = cleanTracks(stored.cols, PRESETS[id].areas[0].length);
    const rows = cleanTracks(stored.rows, PRESETS[id].areas.length);
    if (cols && rows) tracks[id] = { cols, rows };
  }
  const maximized = value.maximized && panes.some(pane => paneId(pane) === value.maximized) ? value.maximized : null;
  return { v: 1, preset, tracks, panes, parked, maximized, compare: value.compare, onlyDifferences: value.onlyDifferences, noteId: value.noteId };
}

export const tracksOf = (desk: DeskLayout, id: PresetId = desk.preset): Tracks => desk.tracks[id] ?? defaultTracks(id);

export type Rect = { x: number; y: number; w: number; h: number };

const starts = (shares: readonly number[]) => shares.map((_, i) => shares.slice(0, i).reduce((sum, share) => sum + share, 0));

/** Where each slot sits on a desk of size 1×1. */
export function slotRects(id: PresetId, tracks: Tracks = defaultTracks(id)): Rect[] {
  const { areas, slots } = PRESETS[id];
  const x = starts(tracks.cols);
  const y = starts(tracks.rows);
  return Array.from({ length: slots }, (_, slot) => {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    areas.forEach((row, r) => row.forEach((cell, c) => {
      if (cell !== slot) return;
      left = Math.min(left, x[c]);
      top = Math.min(top, y[r]);
      right = Math.max(right, x[c] + tracks.cols[c]);
      bottom = Math.max(bottom, y[r] + tracks.rows[r]);
    }));
    return { x: left, y: top, w: right - left, h: bottom - top };
  });
}

/** A line between two columns (axis "cols") or rows, over the tracks of the other axis it separates. */
export type Divider = { axis: "cols" | "rows"; index: number; from: number; to: number };

/** The draggable lines of an arrangement: one per stretch where the cells on its two sides differ. */
export function dividersOf(id: PresetId): Divider[] {
  const { areas } = PRESETS[id];
  const found: Divider[] = [];
  const add = (axis: Divider["axis"], index: number, separates: (along: number) => boolean, length: number) => {
    let start = -1;
    for (let along = 0; along <= length; along++) {
      const differs = along < length && separates(along);
      if (differs && start < 0) start = along;
      if (!differs && start >= 0) {
        found.push({ axis, index, from: start, to: along });
        start = -1;
      }
    }
  };
  const cols = areas[0].length;
  for (let index = 0; index < cols - 1; index++) add("cols", index, row => areas[row][index] !== areas[row][index + 1], areas.length);
  for (let index = 0; index < areas.length - 1; index++) add("rows", index, col => areas[index][col] !== areas[index + 1][col], cols);
  return found;
}

/** Moves the line after track `index` by `delta` (a share of the desk), never making a track thinner than `min`. */
export function resizeTracks(shares: readonly number[], index: number, delta: number, min = MIN_TRACK): number[] {
  if (index < 0 || index >= shares.length - 1) return [...shares];
  const pair = shares[index] + shares[index + 1];
  const first = Math.min(Math.max(shares[index] + delta, min), pair - min);
  return shares.map((share, i) => (i === index ? first : i === index + 1 ? pair - first : share));
}

/** Sets the size of one line of the current arrangement. */
export function resizeDivider(desk: DeskLayout, axis: Divider["axis"], index: number, delta: number): DeskLayout {
  const current = tracksOf(desk);
  return { ...desk, tracks: { ...desk.tracks, [desk.preset]: { ...current, [axis]: resizeTracks(current[axis], index, delta) } } };
}

export function resetTracks(desk: DeskLayout): DeskLayout {
  const tracks = { ...desk.tracks };
  delete tracks[desk.preset];
  return { ...desk, tracks };
}

export function setPreset(desk: DeskLayout, id: PresetId): DeskLayout {
  return PRESETS[id].slots === Math.max(desk.panes.length, 1) ? { ...desk, preset: id } : desk;
}

/** The arrangement after the pane count changed: the same one when it still fits, else the default. */
const presetAfter = (desk: DeskLayout, n: number): PresetId => (PRESETS[desk.preset].slots === Math.max(n, 1) ? desk.preset : defaultPreset(n));

/** Opens an issue on the desk: already there, nothing changes; parked, it comes back; a full desk parks its last pane. */
export function addPane(desk: DeskLayout, pane: DeskPane): DeskLayout {
  const id = paneId(pane);
  if (desk.panes.some(item => paneId(item) === id)) return desk;
  const parked = desk.parked.filter(item => paneId(item) !== id);
  if (desk.panes.length < DESK_MAX_PANES) {
    const panes = [...desk.panes, pane];
    return { ...desk, panes, parked, preset: presetAfter(desk, panes.length) };
  }
  const out = desk.panes[desk.panes.length - 1];
  return park({ ...desk, parked }, paneId(out), pane);
}

export function removePane(desk: DeskLayout, id: string): DeskLayout {
  const panes = desk.panes.filter(pane => paneId(pane) !== id);
  return { ...desk, panes, parked: desk.parked.filter(pane => paneId(pane) !== id), preset: presetAfter(desk, panes.length), maximized: desk.maximized === id ? null : desk.maximized };
}

/** Moves a pane to the tray; `replacement` (or nothing) takes its slot. */
export function park(desk: DeskLayout, id: string, replacement?: DeskPane): DeskLayout {
  const at = desk.panes.findIndex(pane => paneId(pane) === id);
  if (at < 0) return desk;
  const out = desk.panes[at];
  const panes = replacement ? desk.panes.map((pane, i) => (i === at ? replacement : pane)) : desk.panes.filter((_, i) => i !== at);
  const parked = [out, ...desk.parked.filter(pane => paneId(pane) !== id && (!replacement || paneId(pane) !== paneId(replacement)))].slice(0, DESK_MAX_PARKED);
  return { ...desk, panes, parked, preset: presetAfter(desk, panes.length), maximized: desk.maximized === id ? null : desk.maximized };
}

/** Brings a parked issue back: in place of `replacing` when given (or when the desk is full, of the last pane). */
export function unpark(desk: DeskLayout, id: string, replacing?: string): DeskLayout {
  const pane = desk.parked.find(item => paneId(item) === id);
  if (!pane) return desk;
  const rest = { ...desk, parked: desk.parked.filter(item => paneId(item) !== id) };
  const target = replacing ?? (desk.panes.length >= DESK_MAX_PANES ? paneId(desk.panes[desk.panes.length - 1]) : undefined);
  return target ? park(rest, target, pane) : addPane(rest, pane);
}

export function maximize(desk: DeskLayout, id: string | null): DeskLayout {
  return { ...desk, maximized: id && desk.panes.some(pane => paneId(pane) === id) ? id : null };
}

export function swapPanes(desk: DeskLayout, a: number, b: number): DeskLayout {
  if (a === b || !desk.panes[a] || !desk.panes[b]) return desk;
  const panes = [...desk.panes];
  [panes[a], panes[b]] = [panes[b], panes[a]];
  return { ...desk, panes };
}

/** Where a dragged pane can go: a slot of an arrangement (the others keep their order), or another pane's place. */
export type SnapTarget = { kind: "slot"; preset: PresetId; slot: number } | { kind: "swap"; index: number };

/** Puts pane `index` where the target says. */
export function applySnap(desk: DeskLayout, index: number, target: SnapTarget): DeskLayout {
  const moving = desk.panes[index];
  if (!moving) return desk;
  if (target.kind === "swap") return swapPanes(desk, index, target.index);
  if (PRESETS[target.preset].slots !== desk.panes.length || target.slot < 0 || target.slot >= desk.panes.length) return desk;
  const others = desk.panes.filter((_, i) => i !== index);
  const panes = [...others.slice(0, target.slot), moving, ...others.slice(target.slot)];
  return { ...desk, panes, preset: target.preset };
}

export type Edge = "left" | "right" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** What each edge and corner of the desk means for n panes (null: nothing there). Corners need 3 or 4. */
export function edgeTarget(edge: Edge, n: number): SnapTarget | null {
  const slot = (preset: PresetId, at: number): SnapTarget => ({ kind: "slot", preset, slot: at });
  if (n === 2) {
    const map: Partial<Record<Edge, SnapTarget>> = { left: slot("cols-2", 0), right: slot("cols-2", 1), top: slot("rows-2", 0), bottom: slot("rows-2", 1) };
    return map[edge] ?? null;
  }
  if (n === 3) {
    const map: Record<Edge, SnapTarget> = {
      left: slot("main-left", 0), right: slot("main-right", 0), top: slot("main-top", 0), bottom: slot("main-bottom", 0),
      "top-left": slot("main-right", 1), "bottom-left": slot("main-right", 2), "top-right": slot("main-left", 1), "bottom-right": slot("main-left", 2),
    };
    return map[edge];
  }
  if (n === 4) {
    const map: Record<Edge, SnapTarget> = {
      "top-left": slot("quad", 0), "top-right": slot("quad", 1), "bottom-left": slot("quad", 2), "bottom-right": slot("quad", 3),
      left: slot("cols-4", 0), right: slot("cols-4", 3), top: slot("quad", 0), bottom: slot("quad", 2),
    };
    return map[edge];
  }
  return null;
}

/** Every place a pane can be sent with n panes, in reading order: for the keyboard and the "Move to" menu. */
export function snapTargets(n: number): SnapTarget[] {
  return presetsFor(n).flatMap(preset => Array.from({ length: n }, (_, slot): SnapTarget => ({ kind: "slot", preset, slot })));
}

/** Two targets that name the same place. */
export const sameTarget = (a: SnapTarget | null, b: SnapTarget | null): boolean =>
  a === b || (!!a && !!b && (a.kind === "swap" ? b.kind === "swap" && a.index === b.index : b.kind === "slot" && a.preset === b.preset && a.slot === b.slot));

/**
 * Every place pane `index` can be moved to, for the keyboard: the slots of every arrangement in
 * reading order (where it is now among them), then the other panes' places; a place that would
 * give the same desk as an earlier one is left out.
 */
export function moveTargets(desk: DeskLayout, index: number): SnapTarget[] {
  if (!desk.panes[index]) return [];
  const swaps = desk.panes.flatMap((_, other): SnapTarget[] => (other === index ? [] : [{ kind: "swap", index: other }]));
  const seen = new Set<string>();
  return [...snapTargets(desk.panes.length), ...swaps].filter(target => {
    const after = applySnap(desk, index, target);
    const result = `${after.preset} ${after.panes.map(paneId).join(" ")}`;
    if (seen.has(result)) return false;
    seen.add(result);
    return true;
  });
}

/**
 * What lies under the pointer while a pane is dragged (point and rects on a 1×1 desk): an edge band
 * (`band` of the desk; a corner where two meet) snaps there; the middle of another pane swaps with it.
 */
export function zoneAt(point: { x: number; y: number }, n: number, paneRects: readonly Rect[], dragged: number | null, band = 0.18): SnapTarget | null {
  const nearLeft = point.x < band, nearRight = point.x > 1 - band, nearTop = point.y < band, nearBottom = point.y > 1 - band;
  const vertical = nearTop ? "top" : nearBottom ? "bottom" : null;
  const horizontal = nearLeft ? "left" : nearRight ? "right" : null;
  const edge: Edge | null = vertical && horizontal ? `${vertical}-${horizontal}` : vertical ?? horizontal;
  if (edge) {
    const target = edgeTarget(edge, n);
    // A corner with no meaning of its own for this count falls back to its side.
    return target ?? (vertical && horizontal ? edgeTarget(horizontal, n) : null);
  }
  const inner = paneRects.findIndex((rect, i) => i !== dragged && point.x > rect.x + rect.w * 0.2 && point.x < rect.x + rect.w * 0.8 && point.y > rect.y + rect.h * 0.2 && point.y < rect.y + rect.h * 0.8);
  return inner >= 0 ? { kind: "swap", index: inner } : null;
}

/**
 * The arrangement drawn on a desk too small for the chosen one (columns or rows under the minimum):
 * the closest one with as many slots that fits. The chosen one stays saved.
 */
export function fitPreset(id: PresetId, width: number, height: number, minWidth: number, minHeight: number): PresetId {
  const fits = (candidate: PresetId) => PRESETS[candidate].areas[0].length * minWidth <= width && PRESETS[candidate].areas.length * minHeight <= height;
  if (fits(id)) return id;
  const fallbacks: Record<PresetId, PresetId[]> = {
    single: [],
    "cols-2": ["rows-2"],
    "rows-2": ["cols-2"],
    "cols-3": ["main-left", "main-top"],
    "cols-4": ["quad"],
    "main-left": ["main-top", "cols-3"],
    "main-right": ["main-top", "cols-3"],
    "main-top": ["main-left", "cols-3"],
    "main-bottom": ["main-left", "cols-3"],
    quad: ["cols-4"],
  };
  return fallbacks[id].find(fits) ?? id;
}
