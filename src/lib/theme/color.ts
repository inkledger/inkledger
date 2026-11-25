/**
 * Colour math for theme derivation: sRGB <-> OKLab/OKLCH (Björn Ottosson),
 * gamut mapping by chroma reduction, WCAG 2 contrast, and the "h s% l%"
 * triplet format used by the CSS tokens.
 */

export type Rgb = { r: number; g: number; b: number }; // gamma-encoded sRGB, 0..1
export type Oklch = { l: number; c: number; h: number }; // h in degrees

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function toLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function fromLinear(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

export function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

export function toHex({ r, g, b }: Rgb): string {
  const h = (v: number) =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/** Unclamped linear sRGB of an OKLCH colour (channels may fall outside 0..1). */
function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

export function rgbToOklch({ r, g, b }: Rgb): Oklch {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  );
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

function inGamut(lin: [number, number, number]): boolean {
  return lin.every(v => v >= -1e-4 && v <= 1 + 1e-4);
}

/** OKLCH → sRGB, reducing chroma (keeping L and h) until it fits the gamut. */
export function oklchToRgb(color: Oklch): Rgb {
  let lin = oklchToLinear(color);
  if (!inGamut(lin)) {
    let lo = 0;
    let hi = color.c;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ ...color, c: mid }))) lo = mid;
      else hi = mid;
    }
    lin = oklchToLinear({ ...color, c: lo });
  }
  return {
    r: clamp01(fromLinear(clamp01(lin[0]))),
    g: clamp01(fromLinear(clamp01(lin[1]))),
    b: clamp01(fromLinear(clamp01(lin[2]))),
  };
}

function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2 contrast ratio (1..21). */
export function contrast(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** sRGB → "h s% l%" (the token format consumed as hsl(var(--x))). */
export function toHslTriplet({ r, g, b }: Rgb): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d > 1e-9) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  const f = (x: number) => Math.round(x * 10) / 10;
  return `${f(h)} ${f(s * 100)}% ${f(l * 100)}%`;
}

export const WHITE: Rgb = { r: 1, g: 1, b: 1 };

/** A colour vision deficiency, as a dichromat sees (Machado, Oliveira &amp; Fernandes 2009, severity 1). */
export type Cvd = "protan" | "deutan" | "tritan";
const MACHADO: Record<Cvd, number[][]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** How `cvd` sees a colour (none: as it is). */
export function simulateCvd(c: Rgb, cvd?: Cvd): Rgb {
  if (!cvd) return c;
  const lin = [toLinear(c.r), toLinear(c.g), toLinear(c.b)];
  const [r, g, b] = MACHADO[cvd].map(row => fromLinear(clamp01(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])));
  return { r, g, b };
}

/** Distance of two colours in OKLab ×100 (≈ 2 is a just-noticeable step), as `cvd` sees them. */
export function deltaE(a: Rgb, b: Rgb, cvd?: Cvd): number {
  const lab = (c: Rgb) => {
    const o = rgbToOklch(simulateCvd(c, cvd));
    const rad = (o.h * Math.PI) / 180;
    return [o.l, o.c * Math.cos(rad), o.c * Math.sin(rad)];
  };
  const x = lab(a);
  const y = lab(b);
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
