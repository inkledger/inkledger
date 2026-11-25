import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { clampWidth, widthForKey, type SplitBounds } from "@/lib/layout/split";
import { cn } from "@/lib/utils";

/**
 * The line between a list and the pane on its right that resizes the pane (the ARIA window splitter):
 * dragged, ← / → (16 px, Shift: 64 px), Home / End to its limits, a double click back to the default.
 * While dragged it writes `cssVar` on the grid directly, once a frame, and the width is changed once, when
 * it is let go. The grid's track clamps the variable in CSS too, so a stored width never breaks a minimum
 * after the window narrows. Sits over the pane's left edge (its parent is the pane, positioned, with its own
 * `border-l`): that border is the handle, always drawn; on hover, focus and drag a 2 px line in the primary
 * marks it, over an 8 px hit area that is never drawn.
 */
export function Splitter({
  grid,
  pane,
  cssVar,
  bounds,
  onChange,
  label,
  className,
}: {
  /** The grid whose track reads `cssVar`. */
  grid: RefObject<HTMLElement | null>;
  /** The pane it resizes (its id is the separator's aria-controls). */
  pane: { id: string; ref: RefObject<HTMLElement | null> };
  cssVar: `--${string}`;
  /** The pane's limits in a grid this wide. */
  bounds: (gridWidth: number) => SplitBounds;
  /** A new width in px, or null: back to the default. */
  onChange: (width: number | null) => void;
  label: string;
  className?: string;
}) {
  const self = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ right: number; width: number; start: number; frame: number } | null>(null);
  const limits = () => bounds(grid.current?.clientWidth ?? 0);

  // Its value is the pane's width as drawn (after the track's clamp), kept on the element directly: a
  // drag resizes the pane every frame and nothing here needs to render for it.
  useEffect(() => {
    const el = self.current;
    const target = pane.ref.current;
    if (!el || !target) return;
    const ro = new ResizeObserver(() => {
      const { min, max } = limits();
      el.setAttribute("aria-valuenow", String(Math.round(target.offsetWidth)));
      el.setAttribute("aria-valuemin", String(min));
      el.setAttribute("aria-valuemax", String(max));
    });
    ro.observe(target);
    if (grid.current) ro.observe(grid.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- limits reads the refs when called
  }, [grid, pane.ref]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey || !pane.ref.current) return;
    const next = widthForKey(e.key, pane.ref.current.offsetWidth, limits(), e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    onChange(next);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const target = pane.ref.current;
    if (e.button !== 0 || !target) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    const box = target.getBoundingClientRect();
    drag.current = { right: box.right, width: box.width, start: box.width, frame: 0 };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.width = clampWidth(d.right - e.clientX, limits());
    if (d.frame) return;
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      grid.current?.style.setProperty(cssVar, `${d.width}px`);
    });
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;
    if (d.frame) cancelAnimationFrame(d.frame);
    if (Math.round(d.width) !== Math.round(d.start)) {
      grid.current?.style.setProperty(cssVar, `${d.width}px`);
      onChange(d.width);
    }
  };

  return (
    <div
      ref={self}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-controls={pane.id}
      aria-label={label}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onChange(null)}
      className={cn(
        // An 8 px hit area centred on the pane's 1 px border (the visible handle at rest).
        "group/splitter absolute inset-y-0 -left-[4.5px] z-20 w-[8px] cursor-col-resize touch-none outline-none",
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-[2.5px] w-[2px] bg-primary/60 opacity-0 group-hover/splitter:opacity-100 group-focus-visible/splitter:bg-primary group-focus-visible/splitter:opacity-100",
          dragging && "bg-primary opacity-100"
        )}
      />
    </div>
  );
}
