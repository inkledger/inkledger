import type { CSSProperties } from "react";
import { dividersOf, paneId, PRESETS, tracksOf, type DeskLayout, type PresetId, type Tracks } from "@contracts/desk";
import { DeskDivider } from "@/components/desk/DeskDivider";
import { lineVars, template } from "@/lib/desk/grid";
import { DeskPane } from "@/components/desk/DeskPane";
import type { PaneControls } from "@/components/desk/PaneHeader";
import type { DeskChange } from "@/lib/desk/useDesk";

/** Sets the sizes of one axis of an arrangement (the one drawn, which may not be the chosen one). */
const withTracks = (desk: DeskLayout, preset: PresetId, axis: keyof Tracks, shares: number[]): DeskLayout => ({
  ...desk,
  tracks: { ...desk.tracks, [preset]: { ...tracksOf(desk, preset), [axis]: shares } },
});

/**
 * The panes on a grid of the arrangement drawn: named areas, columns and rows by their
 * shares, a hairline between panes (the grid's gap over the border colour), a divider on
 * each line between two panes. Maximized, one pane fills it and the others hide.
 */
export function Desk({
  desk,
  drawn,
  gridRef,
  controlsFor,
  onFocusPane,
  change,
}: {
  desk: DeskLayout;
  drawn: PresetId;
  gridRef: React.RefObject<HTMLDivElement | null>;
  controlsFor: (index: number) => PaneControls;
  onFocusPane: (id: string) => void;
  change: (fn: DeskChange, options?: { saveNow?: boolean }) => void;
}) {
  const preset = PRESETS[drawn];
  const tracks = tracksOf(desk, drawn);
  const maximized = desk.maximized;
  const keyAt = (row: number, col: number) => desk.panes[preset.areas[row][col]]?.key ?? "";
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
    <div ref={gridRef} style={style} className="relative grid h-full min-h-0 gap-px bg-border">
      {desk.panes.map((pane, index) => {
        const id = paneId(pane);
        const hidden = maximized !== null && maximized !== id;
        return (
          <DeskPane
            key={id}
            id={id}
            controls={controlsFor(index)}
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
              other={vertical ? tracks.rows : tracks.cols}
              grid={gridRef}
              between={between}
              onResize={(shares, commit) => change(d => withTracks(d, drawn, divider.axis, shares), { saveNow: commit })}
              onReset={() => change(d => withTracks(d, drawn, divider.axis, tracksOf({ ...d, tracks: {} }, drawn)[divider.axis]), { saveNow: true })}
            />
          );
        })}
    </div>
  );
}
