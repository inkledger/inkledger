/**
 * Where an idea moved to a column's end goes: after the last one shown there. Positions are shared by every
 * project in that state and keep gaps after deletes, so a count of the cards shown would land mid-column.
 */
export function endOfColumn(column: readonly { position: number }[]): number {
  return column.reduce((end, idea) => Math.max(end, idea.position + 1), 0);
}
