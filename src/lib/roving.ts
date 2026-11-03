/**
 * Where the arrow keys take the focus in a row of choices (tabs, segments): one Tab stop, the arrows
 * move inside it, Home and End jump to the ends, and it wraps. A key with a modifier is never ours:
 * Alt+arrows go back and forward, Alt+Shift+arrows move the Desk's panes (useHotkeys).
 */
export function nextIndex(
  current: number,
  count: number,
  key: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
): number | null {
  if (count <= 0 || key.altKey || key.ctrlKey || key.metaKey || key.shiftKey) return null;
  const from = current >= 0 && current < count ? current : 0;
  switch (key.key) {
    case "ArrowRight":
    case "ArrowDown":
      return (from + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (from - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
