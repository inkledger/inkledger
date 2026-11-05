import { useState, type KeyboardEvent, type RefObject } from "react";

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

/**
 * The one Tab stop of a grid (cells marked data-cell="row,col"): arrows move between cells and focus
 * them, kept inside the grid when its rows change. `tab(r, c)` is a cell's tabIndex; a cell that gets
 * focus by other means (click) tells it with `setActive`.
 */
export function useGridFocus(table: RefObject<HTMLElement | null>, rows: number, columns: number, initial: [number, number]) {
  const [active, setActive] = useState<[number, number]>(initial);
  const at: [number, number] = [Math.min(active[0], Math.max(0, rows - 1)), Math.min(active[1], columns - 1)];
  const tab = (r: number, c: number) => (at[0] === r && at[1] === c ? 0 : -1);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const [r, c] = at;
    let next: [number, number] | null = null;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const to = r + (event.key === "ArrowDown" ? 1 : -1);
      if (to >= 0 && to < rows) next = [to, c];
    } else {
      const to = nextIndex(c, columns, event);
      if (to !== null) next = [r, to];
    }
    if (!next) return;
    event.preventDefault();
    setActive(next);
    table.current?.querySelector<HTMLElement>(`[data-cell="${next[0]},${next[1]}"]`)?.focus();
  };
  return { tab, onKeyDown, setActive };
}
