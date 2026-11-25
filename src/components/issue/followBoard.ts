/**
 * A board just made, shown at once and for good. A list still loading when
 * the board was made answers without it, and a refetch asked meanwhile only
 * joins that load (a query with no data yet is never restarted): the load is
 * dropped first, the board put in the list, then the list read again.
 */

/** The list with the board in it (in its place when there already); none while the list is unread. */
export function withBoard<B extends { id: number }>(old: B[] | undefined, board: B): B[] | undefined {
  if (!old) return old;
  return old.some(b => b.id === board.id) ? old.map(b => (b.id === board.id ? board : b)) : [...old, board];
}

export async function showNewBoard<B extends { id: number }>(
  list: {
    /** Drops a load already under way (it may predate the board). */
    cancel(): Promise<void>;
    setData(update: (old: B[] | undefined) => B[] | undefined): void;
    /** Reads the list again, resolved once it has. */
    invalidate(): Promise<void>;
  },
  board: B,
): Promise<void> {
  await list.cancel();
  list.setData(old => withBoard(old, board));
  await list.invalidate();
}
