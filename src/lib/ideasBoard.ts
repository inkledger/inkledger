/** The highest index ideas.move accepts. */
const MAX_POSITION = 5000;

/**
 * Where an idea moved to a column's end goes: after the last one shown there. Positions are shared by every
 * project in that state and keep gaps after deletes, so a count of the cards shown would land mid-column.
 */
export function endOfColumn(column: readonly { position: number }[]): number {
  // Within what the server takes (a column with gaps can reach past it over time).
  return Math.min(MAX_POSITION, column.reduce((end, idea) => Math.max(end, idea.position + 1), 0));
}
