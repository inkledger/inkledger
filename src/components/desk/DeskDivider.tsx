import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { MIN_TRACK, resizeTracks, type Divider } from "@contracts/desk";
import { cn } from "@/lib/utils";
import { lineAt, lineVars, template } from "@/lib/desk/grid";
import { t } from "@/i18n";

/** Arrow keys move a divider by this share of the desk; with Shift, by the larger one. */
const STEP = 0.02;
const BIG_STEP = 0.1;

/**
 * A line between panes that resizes them (the ARIA window splitter): arrows move it
 * (Shift: further), Home and End to its limits, a double click back to even; dragged,
 * it rewrites the grid directly and the desk is changed once, when it is let go.
 */
export function DeskDivider({
  divider: { axis, index, from, to },
  shares,
  other,
  grid,
  between,
  onResize,
  onReset,
}: {
  divider: Divider;
  /** The tracks it sits between (columns for a vertical line), as now. */
  shares: readonly number[];
  /** The tracks of the other axis (to write the grid while dragging). */
  other: readonly number[];
  grid: RefObject<HTMLElement | null>;
  /** The keys of the panes on each side. */
  between: [string, string];
  onResize: (shares: number[], commit: boolean) => void;
  onReset: () => void;
}) {
  const vertical = axis === "cols";
  const [dragging, setDragging] = useState(false);
  const live = useRef<number[] | null>(null);
  const at = Math.round(shares[index] * 100);
  const max = Math.round((shares[index] + shares[index + 1] - MIN_TRACK) * 100);

  const nudge = (delta: number) => onResize(resizeTracks(shares, index, delta), false);
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    const back = vertical ? "ArrowLeft" : "ArrowUp";
    const forth = vertical ? "ArrowRight" : "ArrowDown";
    const delta = e.key === back ? -step : e.key === forth ? step : e.key === "Home" ? -1 : e.key === "End" ? 1 : 0;
    if (!delta || e.altKey || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    nudge(delta);
  };

  const write = (next: readonly number[]) => {
    const el = grid.current;
    if (!el) return;
    el.style.setProperty(vertical ? "grid-template-columns" : "grid-template-rows", template(next));
    const vars = vertical ? lineVars(next, other) : lineVars(other, next);
    for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    live.current = [...shares];
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = grid.current;
    if (!live.current || !el) return;
    const rect = el.getBoundingClientRect();
    const point = vertical ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
    live.current = resizeTracks(shares, index, point - lineAt(shares, index));
    write(live.current);
  };
  const onPointerUp = () => {
    const next = live.current;
    live.current = null;
    setDragging(false);
    if (next?.some((share, i) => share !== shares[i])) onResize(next, true);
  };

  const v = (name: string) => `var(--desk-${name})`;
  const position = vertical
    ? { left: `calc(${v(`x${index + 1}`)} * 100% - 12px)`, top: `calc(${v(`y${from}`)} * 100%)`, height: `calc((${v(`y${to}`)} - ${v(`y${from}`)}) * 100%)` }
    : { top: `calc(${v(`y${index + 1}`)} * 100% - 12px)`, left: `calc(${v(`x${from}`)} * 100%)`, width: `calc((${v(`x${to}`)} - ${v(`x${from}`)}) * 100%)` };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-valuenow={at}
      aria-valuemin={Math.round(MIN_TRACK * 100)}
      aria-valuemax={max}
      aria-label={t("pages.desk.resizeBetween", { first: between[0], second: between[1] })}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      style={position}
      className={cn(
        // A 24 px hit area over the 1 px line between the panes; the handle shows on hover, drag and focus.
        "group/divider absolute z-20 flex touch-none items-center justify-center outline-none",
        vertical ? "w-target cursor-col-resize" : "h-target cursor-row-resize"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "rounded-full bg-muted-foreground/50 opacity-0 transition-opacity group-hover/divider:opacity-100 group-focus-visible/divider:opacity-100 group-focus-visible/divider:ring-2 group-focus-visible/divider:ring-ring",
          vertical ? "h-full max-h-16 w-1" : "h-1 w-full max-w-16",
          dragging && "bg-primary opacity-100"
        )}
      />
    </div>
  );
}
