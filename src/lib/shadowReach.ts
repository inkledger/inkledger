/** How far a box-shadow reaches past its box, per side, in px. */
export type Reach = { l: number; r: number; t: number; b: number };

export const NO_REACH: Reach = { l: 0, r: 0, t: 0, b: 0 };

/** The layers of a box-shadow list: split on the commas outside parentheses. */
function layers(shadow: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < shadow.length; i++) {
    const c = shadow[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      out.push(shadow.slice(from, i));
      from = i + 1;
    }
  }
  out.push(shadow.slice(from));
  return out.map(s => s.trim()).filter(Boolean);
}

/**
 * The reach of a box-shadow (as the Shadow mod writes `--sh-N`): for each
 * outer layer, offset + blur + spread on the side it falls, the widest of
 * all layers. Inset layers and anything unreadable reach nothing.
 */
export function reachOf(shadow: string): Reach {
  const r = { ...NO_REACH };
  for (const layer of layers(shadow)) {
    if (/\binset\b/.test(layer)) continue;
    // The lengths come first: dx dy [blur [spread]], the colour after them.
    const head = layer.replace(/(hsla?|rgba?|var|color-mix|oklch|oklab|lab|lch)\(.*$/, "").trim();
    const nums: number[] = [];
    for (const tok of head.split(/\s+/)) {
      const m = /^(-?\d*\.?\d+)(px)?$/.exec(tok);
      if (!m) break;
      nums.push(Number(m[1]));
    }
    if (nums.length < 2) continue;
    const [dx, dy, blur = 0, spread = 0] = nums;
    const out = Math.max(0, blur) + spread;
    r.l = Math.max(r.l, out - dx);
    r.r = Math.max(r.r, out + dx);
    r.t = Math.max(r.t, out - dy);
    r.b = Math.max(r.b, out + dy);
  }
  return { l: Math.ceil(r.l), r: Math.ceil(r.r), t: Math.ceil(r.t), b: Math.ceil(r.b) };
}
