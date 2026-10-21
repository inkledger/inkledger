import { NOTE_SIZE } from "@contracts/pinboard";

/**
 * The pinboard's red strings: a private note hung on the board is tied to its
 * issue's post-it, pin to pin, with a thread that sags under its own weight.
 */
export type Pt = { x: number; y: number };

/** The pin on a post-it: top centre, a little below the edge. */
export const pinOf = (p: Pt): Pt => ({ x: p.x + NOTE_SIZE / 2, y: p.y + 12 });

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * A thread between two pins: a quadratic curve whose middle hangs below the
 * straight line, more for longer threads (a fake catenary), never upwards.
 */
export function stringPath(a: Pt, b: Pt): string {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const sag = Math.min(90, 10 + len * 0.12);
  // A quadratic's middle is halfway between the chord's midpoint and its control point.
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2 + sag * 2;
  return `M ${r1(a.x)} ${r1(a.y)} Q ${r1(cx)} ${r1(cy)} ${r1(b.x)} ${r1(b.y)}`;
}

type Hung = { id: number; issueKey: string | null; issueNoteId?: number | null; x: number; y: number };

/**
 * The strings of a board: from every hung note to its issue's own post-it on
 * the same board (none when that post-it is not there). `live` overrides
 * positions while a post-it is being dragged.
 */
export function threads(notes: Hung[], live: ReadonlyMap<number, Pt> = new Map()): { id: number; from: Pt; to: Pt; d: string }[] {
  const at = (n: Hung): Pt => live.get(n.id) ?? { x: n.x, y: n.y };
  const issueOf = new Map(notes.filter((n) => n.issueKey && !n.issueNoteId).map((n) => [n.issueKey as string, n]));
  return notes.flatMap((n) => {
    const issue = n.issueNoteId && n.issueKey ? issueOf.get(n.issueKey) : undefined;
    if (!issue) return [];
    const from = pinOf(at(n));
    const to = pinOf(at(issue));
    return [{ id: n.id, from, to, d: stringPath(from, to) }];
  });
}
