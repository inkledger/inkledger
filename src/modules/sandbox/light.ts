import type { SurfaceCatalog } from "../types";

/**
 * The light a framed module may cast over the page ("surfaces.light"): a few
 * allowlisted variables, each value parsed by a strict grammar and written
 * back as the host serialises it (never the module's own text), and the
 * [data-surface] rules made here from the host's catalog.
 */

export const LIGHT_NAMES = ["--sh-1", "--sh-2", "--sh-3", "--sh-drop-1", "--sh-drop-2", "--sh-drop-3", "--sh-edge", "--sky-dim"] as const;
export type LightName = (typeof LIGHT_NAMES)[number];
export type Light = Partial<Record<LightName, string>>;

const MAX_VALUE = 512;
/** Shadows in one list (a contact and a cast, an edge on top). */
const MAX_SHADOWS = 4;
const MAX_PX = 200;

type Tok = { k: "num"; n: number; unit: "" | "px" | "%" } | { k: "word"; w: string };
const TOKEN = /\s*(?:(-?(?:\d{1,4}(?:\.\d{1,4})?|\.\d{1,4}))(px|%)?|(#0000|--shadow-color|--night-shadow|drop-shadow|inset|none|hsl|var|[(),/]))/y;

function tokens(s: string): Tok[] | null {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < s.length) {
    if (/^\s*$/.test(s.slice(TOKEN.lastIndex))) break;
    const m = TOKEN.exec(s);
    if (!m) return null;
    if (m[1] !== undefined) out.push({ k: "num", n: Number(m[1]), unit: (m[2] ?? "") as "" | "px" | "%" });
    else out.push({ k: "word", w: m[3] ?? "" });
  }
  return out;
}

/** A recursive-descent reader over the tokens; each rule returns canonical text or null. */
function reader(ts: Tok[]) {
  let i = 0;
  const word = (w: string) => {
    const t = ts[i];
    if (t?.k === "word" && t.w === w) {
      i++;
      return true;
    }
    return false;
  };
  const num = (unit: "" | "px" | "%", min: number, max: number) => {
    const t = ts[i];
    if (t?.k !== "num" || t.unit !== unit || t.n < min || t.n > max) return null;
    i++;
    return t.n;
  };
  /** A length: px, or a bare 0. */
  const len = (min = -MAX_PX) => {
    const t = ts[i];
    if (t?.k !== "num" || t.n < min || t.n > MAX_PX || (t.unit !== "px" && !(t.unit === "" && t.n === 0))) return null;
    i++;
    return `${t.n}px`;
  };
  const color = () => {
    if (!word("hsl") || !word("(")) return null;
    let base: string | null = null;
    if (word("var")) {
      if (!word("(")) return null;
      const v = word("--shadow-color") ? "--shadow-color" : word("--night-shadow") ? "--night-shadow" : null;
      if (!v || !word(")")) return null;
      base = `var(${v})`;
    } else {
      const h = num("", 0, 360);
      const s = num("%", 0, 100);
      const l = num("%", 0, 100);
      if (h === null || s === null || l === null) return null;
      base = `${h} ${s}% ${l}%`;
    }
    if (!word("/")) return null;
    const a = num("", 0, 1);
    if (a === null || !word(")")) return null;
    return `hsl(${base} / ${a})`;
  };
  const shadow = () => {
    const inset = word("inset");
    const parts: string[] = [];
    for (let n = 0; n < 4; n++) {
      const l = len(n === 2 ? 0 : -MAX_PX);
      if (l === null) break;
      parts.push(l);
    }
    if (parts.length < 2) return null;
    const c = color();
    return c === null ? null : [...(inset ? ["inset"] : []), ...parts, c].join(" ");
  };
  return {
    end: () => i === ts.length,
    shadows() {
      const save = i;
      // No light: the flat shadow, as written.
      if (num("", 0, 0) === 0 && num("", 0, 0) === 0 && word("#0000")) return "0 0 #0000";
      i = save;
      const list: string[] = [];
      do {
        const s = shadow();
        if (s === null || list.length >= MAX_SHADOWS) return null;
        list.push(s);
      } while (word(","));
      return list.join(", ");
    },
    drop() {
      if (word("none")) return "none";
      if (!word("drop-shadow") || !word("(")) return null;
      const parts: string[] = [];
      for (let n = 0; n < 3; n++) {
        const l = len(n === 2 ? 0 : -MAX_PX);
        if (l === null) break;
        parts.push(l);
      }
      const c = parts.length >= 2 ? color() : null;
      if (c === null || !word(")")) return null;
      return `drop-shadow(${[...parts, c].join(" ")})`;
    },
    fraction() {
      const n = num("", 0, 1);
      return n === null ? null : String(n);
    },
  };
}

/** One value as the host would write it, or null when it is not in the grammar. */
export function lightValue(name: LightName, value: string): string | null {
  if (value.length > MAX_VALUE) return null;
  const ts = tokens(value);
  if (!ts) return null;
  const r = reader(ts);
  const out = name === "--sky-dim" ? r.fraction() : name.startsWith("--sh-drop-") ? r.drop() : r.shadows();
  return out !== null && r.end() ? out : null;
}

/** The whole light, canonical, or the first name that is refused. */
export function parseLight(vars: Readonly<Record<string, unknown>>): { ok: true; light: Light } | { ok: false; name: string } {
  const light: Light = {};
  for (const [name, value] of Object.entries(vars)) {
    const known = LIGHT_NAMES.find(n => n === name);
    const v = known && typeof value === "string" ? lightValue(known, value) : null;
    if (!known || v === null) return { ok: false, name: name.slice(0, 32) };
    light[known] = v;
  }
  return { ok: true, light };
}

const ELEVATIONS = [1, 2, 3] as const;
const RINGS = "var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000)";

/**
 * The rules that draw the light on the catalog's surfaces: a box-shadow for a
 * box or pill (outside the box only), a drop-shadow for a picture's own
 * outline; glass, grounds and baked pictures get none. Focus rings are kept.
 */
export function lightRules(catalog: SurfaceCatalog, off: readonly string[] = []): string {
  const rules: string[] = [];
  for (const [kind, p] of Object.entries(catalog)) {
    if (!p.cast || p.translucent || p.bakedShadow || p.maxElevation === 0 || off.includes(kind)) continue;
    const edge = p.effects.includes("edge");
    for (const e of ELEVATIONS.filter(e => e <= p.maxElevation)) {
      const at = `[data-surface="${kind}"][data-elev="${e}"]`;
      if (p.shape === "alpha") {
        rules.push(`${at}{filter:var(--sh-drop-${e})}`);
        continue;
      }
      rules.push(`${at}{box-shadow:${RINGS},var(--sh-${e})}`);
      if (edge) rules.push(`${at}:not([data-surface-role="wrap"]):not([data-surface-edge="off"]){box-shadow:${RINGS},var(--sh-edge),var(--sh-${e})}`);
    }
  }
  rules.push(`[data-surface-role="face"]:not([data-surface-edge="off"]){box-shadow:${RINGS},var(--sh-edge)}`);
  rules.push(`[data-surface][data-surface-current]:not([aria-current="page"]){box-shadow:${RINGS};filter:none}`);
  return rules.join("\n");
}

/** Kinds a module switched off, at most this many (the catalog is smaller). */
export const LIGHT_OFF_MAX = 64;

/** The kinds to leave unlit, sorted, or null when one is not in the catalog. */
export function lightOff(catalog: SurfaceCatalog, off: readonly string[]): string[] | null {
  if (off.length > LIGHT_OFF_MAX || off.some(k => !Object.hasOwn(catalog, k))) return null;
  return [...new Set(off)].sort();
}

export type LightPage = {
  root: { setProperty(k: string, v: string): void; removeProperty(k: string): void };
  /** Puts a stylesheet on the page; its undo. */
  addStyle(css: string): { remove(): void };
  /** Runs `fn` before the next paint; its undo. Without it a light is written at once. */
  frame?(fn: () => void): () => void;
};

/**
 * The page's light: one module casts it at a time. Only what changed is
 * written (each write repaints the surfaces), at most once a frame (the
 * latest set wins), and its owner going clears it.
 */
export function createPageLight(page: LightPage, catalog: SurfaceCatalog) {
  let owner: { moduleId: string; token: object } | null = null;
  let applied: Light = {};
  let style: { remove(): void } | null = null;
  let styleOff = "";
  let pending: { light: Light; off: readonly string[] } | null = null;
  let cancel: (() => void) | null = null;
  const apply = () => {
    cancel = null;
    const next = pending;
    pending = null;
    if (!next || !owner) return;
    // The rules change only with the kinds left unlit.
    const key = next.off.join(",");
    if (style && key !== styleOff) {
      style.remove();
      style = null;
    }
    styleOff = key;
    style ??= page.addStyle(lightRules(catalog, next.off));
    for (const k of Object.keys(applied)) if (!(k in next.light)) page.root.removeProperty(k);
    for (const [k, v] of Object.entries(next.light)) if (applied[k as LightName] !== v) page.root.setProperty(k, v);
    applied = { ...next.light };
  };
  const clear = () => {
    cancel?.();
    cancel = null;
    pending = null;
    for (const k of Object.keys(applied)) page.root.removeProperty(k);
    applied = {};
    style?.remove();
    style = null;
    styleOff = "";
    owner = null;
  };
  return {
    /** The kinds a module may leave unlit, checked against the catalog (null: refused). */
    off: (kinds: readonly string[]) => lightOff(catalog, kinds),
    /** False when another module holds the light. `off`: kinds left unlit (checked by `off`). */
    set(moduleId: string, token: object, light: Light | null, off: readonly string[] = []): boolean {
      if (owner && owner.moduleId !== moduleId) return false;
      if (light === null) {
        if (owner) clear();
        return true;
      }
      owner = { moduleId, token };
      pending = { light, off };
      if (!page.frame) apply();
      else cancel ??= page.frame(apply);
      return true;
    },
    /** The frame that last set the light went. */
    release(token: object) {
      if (owner?.token === token) clear();
    },
  };
}
