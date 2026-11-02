import { useLayoutEffect, useRef, type CSSProperties, type DragEvent } from "react";
import { DESK_MAX_PANES, dividersOf, isEmptySlot, minTrackOf, paneId, PRESETS, removePane, sameTarget, slotRects, tracksOf, type DeskLayout, type DeskPane as Pane, type PresetId, type SnapTarget, type Tracks } from "@contracts/desk";
import { DeskDivider } from "@/components/desk/DeskDivider";
import { lineVars, template } from "@/lib/desk/grid";
import { DeskPane } from "@/components/desk/DeskPane";
import { EmptySlot } from "@/components/desk/EmptySlot";
import type { PaneControls } from "@/components/desk/PaneHeader";
import { SnapOverlay } from "@/components/desk/SnapOverlay";
import { snapTargetAt, type SnapStore } from "@/lib/desk/useSnapDrag";
import { slotNames } from "@/lib/desk/targetName";
import { ISSUE_DRAG_TYPE, readIssueDragData } from "@/lib/issues";
import type { DeskChange } from "@/lib/desk/useDesk";

/** Sets the sizes of one axis of an arrangement (the one drawn, which may not be the chosen one). */
const withTracks = (desk: DeskLayout, preset: PresetId, axis: keyof Tracks, shares: number[]): DeskLayout => ({
  ...desk,
  tracks: { ...desk.tracks, [preset]: { ...tracksOf(desk, preset), [axis]: shares } },
});

/**
 * The panes on a grid of the arrangement drawn: named areas, columns and rows by their
 * shares, a hairline between panes (the grid's gap over the field-border colour: a shade firmer
 * than the hairlines inside a pane, so two panes never read as one), a divider on
 * each line between two panes. Maximized, one pane fills it and the others hide. An issue dragged
 * in from a list or the board snaps like a pane moved (with one more place), or fills an empty slot.
 */
export function Desk({
  desk,
  drawn,
  gridRef,
  controlsFor,
  onFocusPane,
  change,
  snap,
  onFill,
  onDropIssue,
}: {
  desk: DeskLayout;
  drawn: PresetId;
  gridRef: React.RefObject<HTMLDivElement | null>;
  controlsFor: (index: number, pane: Pane) => PaneControls;
  onFocusPane: (id: string) => void;
  change: (fn: DeskChange, options?: { saveNow?: boolean }) => void;
  /** A pane being moved: its overlay draws over the grid. */
  snap: SnapStore;
  /** An issue chosen in (or dropped on) empty slot `index`. */
  onFill: (index: number, pane: Pane) => void;
  /** An issue dragged in and dropped on the desk's place `target`. */
  onDropIssue: (pane: Pane, target: SnapTarget) => void;
}) {
  const preset = PRESETS[drawn];
  const tracks = tracksOf(desk, drawn);
  const maximized = desk.maximized;
  // A pane moved to another slot is an element moved in the page, which forgets where it was
  // scrolled: each scroller's place is noted as it scrolls and put back after a move.
  const scrolls = useRef(new WeakMap<Element, number>());
  const order = desk.panes.map(paneId).join(" ");
  useLayoutEffect(() => {
    gridRef.current?.querySelectorAll("[data-pane-size]").forEach(el => {
      const top = scrolls.current.get(el);
      if (top !== undefined && el.scrollTop !== top) el.scrollTop = top;
    });
  }, [order, gridRef]);
  const names = slotNames(desk.panes);
  const keyAt = (row: number, col: number) => names[preset.areas[row][col]] ?? "";
  // An issue dragged in: where it would land, drawn by the snap overlay (an empty slot takes it itself).
  const dragIn = (e: DragEvent<HTMLDivElement>): SnapTarget | null => {
    const grid = gridRef.current;
    if (!grid || maximized || !e.dataTransfer.types.includes(ISSUE_DRAG_TYPE) || (e.target instanceof Element && e.target.closest("[data-empty-slot]"))) return null;
    const rects = slotRects(drawn, tracks);
    if (desk.panes.length < DESK_MAX_PANES) return snapTargetAt(e.clientX, e.clientY, grid, desk.panes.length + 1, rects, null);
    // A full desk: the pane under the pointer gives its place.
    const box = grid.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width, y = (e.clientY - box.top) / box.height;
    const index = rects.findIndex(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    return index >= 0 ? { kind: "swap", index } : null;
  };
  const style = (
    maximized
      ? { gridTemplateAreas: '"max"', gridTemplateColumns: "minmax(0,1fr)", gridTemplateRows: "minmax(0,1fr)" }
      : {
          gridTemplateAreas: preset.areas.map(row => `"${row.map(slot => `p${slot}`).join(" ")}"`).join(" "),
          gridTemplateColumns: template(tracks.cols),
          gridTemplateRows: template(tracks.rows),
          ...lineVars(tracks.cols, tracks.rows),
        }
  ) as CSSProperties;

  return (
    <div
      ref={gridRef}
      style={style}
      onScrollCapture={e => {
        if (e.target instanceof Element) scrolls.current.set(e.target, e.target.scrollTop);
      }}
      onDragOver={e => {
        const target = dragIn(e);
        const now = snap.get();
        if (!target) {
          if (now?.index === -1) snap.set(null);
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (now?.index === -1 && sameTarget(now.target, target)) return;
        snap.set({ id: "", key: "", index: -1, target, mode: "pointer", places: desk.panes.length + 1 });
      }}
      onDragLeave={e => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) && snap.get()?.index === -1) snap.set(null);
      }}
      onDrop={e => {
        const target = snap.get()?.index === -1 ? snap.get()?.target : null;
        if (snap.get()?.index === -1) snap.set(null);
        const issue = readIssueDragData(e.dataTransfer);
        if (!target || !issue) return;
        e.preventDefault();
        onDropIssue(issue, target);
      }}
      data-desk-grid
      className="relative grid h-full min-h-0 gap-px bg-input"
    >
      {desk.panes.map((pane, index) => {
        const id = paneId(pane);
        const hidden = maximized !== null && maximized !== id;
        if (isEmptySlot(pane))
          return (
            <EmptySlot
              key={id}
              id={id}
              desk={desk}
              hidden={hidden}
              style={{ gridArea: `p${index}` }}
              onFill={issue => onFill(index, issue)}
              onClose={() => change(d => removePane(d, id), { saveNow: true })}
              onFocusPane={onFocusPane}
            />
          );
        return (
          <DeskPane
            key={id}
            id={id}
            controls={controlsFor(index, pane)}
            hidden={hidden}
            style={{ gridArea: maximized === id ? "max" : `p${index}` }}
            onFocusPane={onFocusPane}
          />
        );
      })}
      {!maximized &&
        dividersOf(drawn).map(divider => {
          const vertical = divider.axis === "cols";
          const between: [string, string] = vertical
            ? [keyAt(divider.from, divider.index), keyAt(divider.from, divider.index + 1)]
            : [keyAt(divider.index, divider.from), keyAt(divider.index + 1, divider.from)];
          return (
            <DeskDivider
              key={`${divider.axis}-${divider.index}-${divider.from}`}
              divider={divider}
              shares={tracks[divider.axis]}
              min={minTrackOf(drawn, divider.axis)}
              other={vertical ? tracks.rows : tracks.cols}
              grid={gridRef}
              between={between}
              onResize={(shares, commit) => change(d => withTracks(d, drawn, divider.axis, shares), { saveNow: commit })}
              onReset={() => change(d => withTracks(d, drawn, divider.axis, tracksOf({ ...d, tracks: {} }, drawn)[divider.axis]), { saveNow: true })}
            />
          );
        })}
      {!maximized && <SnapOverlay store={snap} desk={desk} drawn={drawn} />}
    </div>
  );
}
