import { readStoredJson, writeStored } from "@/lib/storage";

/**
 * Series colours for charts (docs/design-system.md §3.5): the eight `--data-*` tokens, derived per
 * look from the base colour. A category keeps its colour on every page and period: the first time a
 * key is drawn it takes the next free slot of its dimension, and that choice is saved on this device
 * (a hash would give five issue types the same colour four times in five). In high contrast each slot
 * also wears its own texture, so colour is never the only cue.
 */

export type DataDimension = "type" | "project" | "client";

export type DataColour = {
  /** 1..8, or 0 for "Other" */
  slot: number;
  /** Background class of the series (a bar, a segment, a legend swatch) */
  fill: string;
  /** Its texture in high contrast ("" for the solid first series and for Other) */
  texture: string;
};

export const DATA_SLOTS = 8;

// Literal classes: Tailwind generates only what it can read.
const FILLS = ["bg-data-1", "bg-data-2", "bg-data-3", "bg-data-4", "bg-data-5", "bg-data-6", "bg-data-7", "bg-data-8"] as const;
const TEXTURES = ["", "data-texture-2", "data-texture-3", "data-texture-4", "data-texture-5", "data-texture-6", "data-texture-7", "data-texture-8"] as const;

/** A ninth series is never a new hue: it is summed as "Other", in a quiet neutral. */
export const OTHER_COLOUR: DataColour = { slot: 0, fill: "bg-muted-foreground/40", texture: "" };

const STORE_KEY = "ikl-data-colours";
type Saved = Record<DataDimension, (string | null)[]>;

const empty = (): (string | null)[] => Array.from({ length: DATA_SLOTS }, () => null);
let saved: Saved | null = null;

function load(): Saved {
  if (saved) return saved;
  const raw = readStoredJson(STORE_KEY);
  const slotsOf = (v: unknown): (string | null)[] => {
    const list = empty();
    if (Array.isArray(v)) v.slice(0, DATA_SLOTS).forEach((k, i) => (list[i] = typeof k === "string" && k ? k : null));
    return list;
  };
  const obj = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  saved = { type: slotsOf(obj.type), project: slotsOf(obj.project), client: slotsOf(obj.client) };
  return saved;
}

const persist = () => {
  if (saved) writeStored(STORE_KEY, JSON.stringify(saved));
};

/** "Bug", "bug " and "BUG" are one category. */
const norm = (key: string) => key.trim().toLocaleLowerCase();

const colour = (slot: number): DataColour => ({ slot: slot + 1, fill: FILLS[slot], texture: TEXTURES[slot] });

/** FNV-1a: the fallback slot of a key that finds every slot taken. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The colours of the series a chart draws, in its order (the busiest first): each keeps its saved slot;
 * a new one takes a free slot, else the slot of a key this chart doesn't draw. Past the eighth: Other.
 */
export function assignColours(keys: string[], dimension: DataDimension = "type"): Map<string, DataColour> {
  const slots = load()[dimension];
  const out = new Map<string, DataColour>();
  const drawn = new Set(keys.slice(0, DATA_SLOTS).map(norm));
  let changed = false;
  keys.forEach((key, index) => {
    if (out.has(key)) return;
    if (index >= DATA_SLOTS) return out.set(key, OTHER_COLOUR);
    const k = norm(key);
    let slot = slots.indexOf(k);
    if (slot < 0) {
      slot = slots.indexOf(null);
      if (slot < 0) slot = slots.findIndex(s => s !== null && !drawn.has(s));
      slots[slot] = k;
      changed = true;
    }
    out.set(key, colour(slot));
  });
  if (changed) persist();
  return out;
}

/**
 * The colour of one category: its saved slot (taking a free one the first time). `index` is its place in
 * the chart's order: from the ninth on it is Other. A key that finds all eight slots taken by others gets
 * a hashed slot, not saved; draw a chart's series with `assignColours` to avoid that.
 */
export function colourFor(key: string, index = 0, dimension: DataDimension = "type"): DataColour {
  if (index >= DATA_SLOTS) return OTHER_COLOUR;
  const slots = load()[dimension];
  const k = norm(key);
  const at = slots.indexOf(k);
  if (at >= 0) return colour(at);
  const free = slots.indexOf(null);
  if (free < 0) return colour(hash(k) % DATA_SLOTS);
  slots[free] = k;
  persist();
  return colour(free);
}

/** Forgets the in-memory copy (tests: a new page load). */
export function resetDataColoursCache(): void {
  saved = null;
}
