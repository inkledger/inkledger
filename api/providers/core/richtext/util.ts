// Small pure helpers shared by the markup readers.

import type { Block, Inline } from "@contracts/richtext";

type Image = Extract<Block, { t: "image" }>;

export const isAlnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
export const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c);

export const blank = (x: Inline): boolean => x.t === "br" || (x.t === "text" && x.v.trim() === "");

/** Images split a paragraph; inside a link they shrink to text, elsewhere to a link or an attachment */
export function segsToInlines(segs: (Inline | Image)[], inLink = false): Inline[] {
  return segs.map((s): Inline => {
    if (s.t !== "image") return s;
    if (inLink) return { t: "text", v: s.alt ?? s.name ?? "" };
    if (s.url) return { t: "link", url: s.url, c: [{ t: "text", v: s.alt ?? s.url }] };
    return { t: "attachment", name: s.name ?? "" };
  });
}

/** Drop blank text and breaks at both ends */
export function trimBreaks(xs: Inline[]): Inline[] {
  let a = 0;
  let b = xs.length;
  while (a < b && blank(xs[a])) a++;
  while (b > a && blank(xs[b - 1])) b--;
  return xs.slice(a, b);
}
