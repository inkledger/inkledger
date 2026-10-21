// Where a card may go on the board: only where its own tracker can take it
// (a native transition of its connection), never onto another connection's
// or provider's place. Pure, shared by drag, keyboard and the card's menu.

/** A way on from the card's status, as its tracker lists it. */
export type Way = { toStatus: string; toCategory: string; executable: boolean };

/**
 * A board column: what it stands for on each connection.
 * - by status (in a source's lane): one connection, one status;
 * - by category: any connection's statuses of that category;
 * - custom: the statuses each connection maps onto it.
 */
export type BoardColumn =
  | { kind: "status"; id: string; connectionId: number; status: string }
  | { kind: "category"; id: string; category: string }
  | { kind: "custom"; id: string; statuses: Record<string, string[]> };

export type BoardCardRef = { connectionId: number; status: string };

/**
 * The statuses a card can reach by dropping it on a column: empty when it
 * can't go there (the column stays off while dragging). More than one: the
 * drop asks which.
 */
export function reachable(card: BoardCardRef, ways: readonly Way[], column: BoardColumn): string[] {
  const own = (s: string) => s.toLowerCase() !== card.status.toLowerCase();
  const by = (match: (w: Way) => boolean) => [...new Set(ways.filter(w => own(w.toStatus) && match(w)).map(w => w.toStatus))];
  switch (column.kind) {
    case "status":
      if (column.connectionId !== card.connectionId) return [];
      return by(w => w.toStatus.toLowerCase() === column.status.toLowerCase());
    case "category":
      return by(w => w.toCategory === column.category);
    case "custom": {
      const mapped = new Set((column.statuses[String(card.connectionId)] ?? []).map(s => s.toLowerCase()));
      return by(w => mapped.has(w.toStatus.toLowerCase()));
    }
  }
}

/** Every column the card can go to, with what it would reach there. */
export function dropTargets(card: BoardCardRef, ways: readonly Way[], columns: readonly BoardColumn[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of columns) {
    const to = reachable(card, ways, c);
    if (to.length > 0) out.set(c.id, to);
  }
  return out;
}

/** The column a card shows in, by its connection and status (and category). */
export function columnOf(card: BoardCardRef & { category: string }, columns: readonly BoardColumn[]): string | null {
  const s = card.status.toLowerCase();
  for (const c of columns) {
    if (c.kind === "status" && c.connectionId === card.connectionId && c.status.toLowerCase() === s) return c.id;
    if (c.kind === "category" && c.category === card.category) return c.id;
    if (c.kind === "custom" && (c.statuses[String(card.connectionId)] ?? []).some(x => x.toLowerCase() === s)) return c.id;
  }
  return null;
}
