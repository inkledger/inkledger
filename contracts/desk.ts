import { z } from "zod";

/**
 * The Desk: up to four issues side by side, laid out like windows snapped on a desktop. A layout is
 * one of a few fixed arrangements (halves, thirds, one big and two, quarters) with the size of each
 * of its columns and rows; slot i of the arrangement holds pane i, an issue or an empty slot (a
 * place kept free to open an issue in). Pure: shared by the page and the server, which stores the desk.
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

/** A slot kept free: "Open an issue here". Its id tells it apart from the desk's other empty slots. */
export const emptySlotSchema = z.object({ empty: z.literal(true), id: z.string().regex(/^\d{1,2}$/) }).strict();
export type EmptySlot = z.infer<typeof emptySlotSchema>;
/** What a slot of the arrangement holds. */
export type DeskSlot = DeskPane | EmptySlot;

export const isEmptySlot = (slot: DeskSlot): slot is EmptySlot => "empty" in slot;
export const isIssue = (slot: DeskSlot): slot is DeskPane => !isEmptySlot(slot);
/** The issues on the desk, in slot order (empty slots left out). */
export const deskIssues = (desk: { panes: readonly DeskSlot[] }): DeskPane[] => desk.panes.filter(isIssue);

/** A new empty slot: the first id the desk's slots don't use yet. */
export function emptySlot(slots: readonly DeskSlot[]): EmptySlot {
  const used = new Set(slots.filter(isEmptySlot).map(slot => slot.id));
  let n = 1;
  while (used.has(String(n))) n++;
  return { empty: true, id: String(n) };
}

const tracksSchema = z.object({ cols: z.array(z.number()).max(4), rows: z.array(z.number()).max(4) });

export const deskLayoutSchema = z.object({
  v: z.literal(1),
  preset: z.enum(PRESET_IDS),
  tracks: z.record(z.string(), tracksSchema),
  panes: z.array(z.union([deskPaneSchema, emptySlotSchema])).max(20),
  parked: z.array(deskPaneSchema).max(40),
  maximized: z.string().nullable(),
  compare: z.boolean(),
  onlyDifferences: z.boolean(),
  noteId: z.uuid().nullable(),
});
export type DeskLayout = Omit<z.infer<typeof deskLayoutSchema>, "tracks"> & { tracks: Partial<Record<PresetId, Tracks>> };

/** A slot's id on the desk: the issue's connection and key, or "empty-N". */
export const paneId = (slot: Pick<DeskPane, "connectionId" | "key"> | EmptySlot) => ("empty" in slot ? `empty-${slot.id}` : `${slot.connectionId}:${slot.key}`);

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
 * (or empty slot) never twice, at most four slots (the issues beyond parked) and eight parked, an
 * arrangement that has as many slots as panes, sizes that add up and none too thin. Empty slots stay
 * only beside an issue: a desk of empty slots alone is an empty desk.
 */
export function normalizeDesk(raw: unknown): DeskLayout {
  const parsed = deskLayoutSchema.safeParse(raw);
  if (!parsed.success) return emptyDesk();
  const value = parsed.data;
  const seen = new Set<string>();
  const unique = <T extends DeskSlot>(panes: readonly T[]) => panes.filter(pane => !seen.has(paneId(pane)) && seen.add(paneId(pane)));
  const shown = unique(value.panes);
  const panes = shown.slice(0, DESK_MAX_PANES).some(isIssue) ? shown.slice(0, DESK_MAX_PANES) : [];
  const parked = [...shown.slice(DESK_MAX_PANES).filter(isIssue), ...unique(value.parked)].slice(0, DESK_MAX_PARKED);
  const preset = PRESETS[value.preset].slots === Math.max(panes.length, 1) ? value.preset : defaultPreset(panes.length);
  const tracks: Partial<Record<PresetId, Tracks>> = {};
  for (const id of PRESET_IDS) {
    const stored = value.tracks[id];
    if (!stored) continue;
    const cols = cleanTracks(stored.cols, PRESETS[id].areas[0].length);
    const rows = cleanTracks(stored.rows, PRESETS[id].areas.length);
    if (cols && rows) tracks[id] = { cols, rows };
  }
  const maximized = value.maximized && panes.some(pane => isIssue(pane) && paneId(pane) === value.maximized) ? value.maximized : null;
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

/**
 * Another arrangement: one with more slots than the desk has keeps the extra ones empty, one with
 * fewer drops empty slots from the end; never fewer slots than issues.
 */
export function setPreset(desk: DeskLayout, id: PresetId): DeskLayout {
  const slots = PRESETS[id].slots;
  if (slots < Math.max(deskIssues(desk).length, 1)) return desk;
  if (!desk.panes.length) return slots === 1 ? { ...desk, preset: id } : desk;
  // The empty slots past what fits go, the last ones first.
  let extra = desk.panes.length - slots;
  let panes = [...desk.panes].reverse().filter(pane => !(extra > 0 && isEmptySlot(pane) && extra--)).reverse();
  while (panes.length < slots) panes = [...panes, emptySlot(panes)];
  return { ...desk, preset: id, panes };
}

/** The arrangement after the pane count changed: the same one when it still fits, else the default. */
const presetAfter = (desk: DeskLayout, n: number): PresetId => (PRESETS[desk.preset].slots === Math.max(n, 1) ? desk.preset : defaultPreset(n));

/** The desk with these slots: none when no issue is left among them (empty slots never stand alone). */
const withSlots = (desk: DeskLayout, slots: DeskSlot[]): DeskLayout => {
  const panes = slots.some(isIssue) ? slots : [];
  return { ...desk, panes, preset: presetAfter(desk, panes.length) };
};

/**
 * Opens an issue on the desk: already there, nothing changes; parked, it comes back; the first
 * empty slot takes it; a full desk parks its last pane.
 */
export function addPane(desk: DeskLayout, pane: DeskPane): DeskLayout {
  const id = paneId(pane);
  if (desk.panes.some(item => paneId(item) === id)) return desk;
  const parked = desk.parked.filter(item => paneId(item) !== id);
  const free = desk.panes.findIndex(isEmptySlot);
  if (free >= 0) return { ...desk, panes: desk.panes.map((item, i) => (i === free ? pane : item)), parked };
  if (desk.panes.length < DESK_MAX_PANES) {
    const panes = [...desk.panes, pane];
    return { ...desk, panes, parked, preset: presetAfter(desk, panes.length) };
  }
  const out = desk.panes[desk.panes.length - 1];
  return park({ ...desk, parked }, paneId(out), pane);
}

/** Takes an issue (or an empty slot) off the desk. */
export function removePane(desk: DeskLayout, id: string): DeskLayout {
  return {
    ...withSlots(desk, desk.panes.filter(pane => paneId(pane) !== id)),
    parked: desk.parked.filter(pane => paneId(pane) !== id),
    maximized: desk.maximized === id ? null : desk.maximized,
  };
}

/** Moves a pane to the tray (an empty slot is only closed); `replacement` (or nothing) takes its slot. */
export function park(desk: DeskLayout, id: string, replacement?: DeskPane): DeskLayout {
  const at = desk.panes.findIndex(pane => paneId(pane) === id);
  if (at < 0) return desk;
  const out = desk.panes[at];
  const slots = replacement ? desk.panes.map((pane, i) => (i === at ? replacement : pane)) : desk.panes.filter((_, i) => i !== at);
  const kept = desk.parked.filter(pane => paneId(pane) !== id && (!replacement || paneId(pane) !== paneId(replacement)));
  const parked = (isIssue(out) ? [out, ...kept] : kept).slice(0, DESK_MAX_PARKED);
  return { ...withSlots(desk, slots), parked, maximized: desk.maximized === id ? null : desk.maximized };
}

/** Brings a parked issue back: in place of `replacing` when given, else as an issue added (an empty slot, or the last pane of a full desk). */
export function unpark(desk: DeskLayout, id: string, replacing?: string): DeskLayout {
  const pane = desk.parked.find(item => paneId(item) === id);
  if (!pane) return desk;
  const rest = { ...desk, parked: desk.parked.filter(item => paneId(item) !== id) };
  return replacing ? park(rest, replacing, pane) : addPane(rest, pane);
}

export function maximize(desk: DeskLayout, id: string | null): DeskLayout {
  return { ...desk, maximized: id && desk.panes.some(pane => isIssue(pane) && paneId(pane) === id) ? id : null };
}

/**
 * The desk as `slots` in arrangement `preset` (as many as it has): the issues that were on it and
 * aren't among them go first in the tray, nothing is maximized.
 */
function arrange(desk: DeskLayout, slots: DeskSlot[], preset: PresetId): DeskLayout {
  const ids = new Set(slots.map(paneId));
  const out = deskIssues(desk).filter(pane => !ids.has(paneId(pane)));
  const outIds = new Set(out.map(paneId));
  const parked = [...out, ...desk.parked.filter(pane => !ids.has(paneId(pane)) && !outIds.has(paneId(pane)))].slice(0, DESK_MAX_PARKED);
  return { ...desk, preset, panes: slots, parked, maximized: null };
}

/**
 * An issue sent to the desk from its own page: in slot `slot` of `preset`, the desk's other issues
 * in the other slots in their order while they fit (the rest parked), empty slots for what is left.
 * Already on the desk or parked, it moves there.
 */
export function placeIssue(desk: DeskLayout, pane: DeskPane, preset: PresetId, slot: number): DeskLayout {
  const count = PRESETS[preset].slots;
  if (slot < 0 || slot >= count) return desk;
  const others: DeskSlot[] = deskIssues(desk).filter(item => paneId(item) !== paneId(pane)).slice(0, count - 1);
  while (others.length < count - 1) others.push(emptySlot(others));
  return arrange(desk, [...others.slice(0, slot), pane, ...others.slice(slot)], preset);
}

/** Two issues side by side (an issue's page and the one Shift-clicked on it); the desk's others parked. */
export function sideBySide(desk: DeskLayout, first: DeskPane, second: DeskPane): DeskLayout {
  return paneId(first) === paneId(second) ? placeIssue(desk, first, "single", 0) : arrange(desk, [first, second], "cols-2");
}

/** Issues picked together (the Issues list's selection), side by side in the default arrangement for their count; the desk's others parked. */
export function openTogether(desk: DeskLayout, panes: readonly DeskPane[]): DeskLayout {
  const seen = new Set<string>();
  const shown = panes.filter(pane => !seen.has(paneId(pane)) && seen.add(paneId(pane))).slice(0, DESK_MAX_PANES);
  return shown.length ? arrange(desk, shown, defaultPreset(shown.length)) : desk;
}

const PAGE_ORDER: PresetId[] = ["cols-2", "rows-2", "main-left", "main-right", "cols-3", "quad", "cols-4", "main-top", "main-bottom"];
/** The arrangements an issue's page offers to send it to, `n` the issues the desk would hold with it: those with room for them all, at most six. */
export const pagePresets = (n: number): PresetId[] => PAGE_ORDER.filter(id => PRESETS[id].slots >= Math.min(Math.max(n, 2), DESK_MAX_PANES)).slice(0, 6);

/**
 * An issue dropped on the desk from outside it (a list, the board): a slot of an arrangement with
 * one more place than the desk has, or a pane's place (it fills an empty slot, parks an issue).
 * Already on the desk, nothing changes.
 */
export function dropIssue(desk: DeskLayout, pane: DeskPane, target: SnapTarget): DeskLayout {
  if (desk.panes.some(item => paneId(item) === paneId(pane))) return desk;
  if (target.kind === "swap") return desk.panes[target.index] ? park(desk, paneId(desk.panes[target.index]), pane) : desk;
  if (PRESETS[target.preset].slots !== desk.panes.length + 1 || target.slot < 0 || target.slot > desk.panes.length) return desk;
  const panes = [...desk.panes.slice(0, target.slot), pane, ...desk.panes.slice(target.slot)];
  return { ...desk, panes, preset: target.preset, parked: desk.parked.filter(item => paneId(item) !== paneId(pane)), maximized: null };
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
