import { presetsFor, slotRects, tracksOf, type DeskLayout, type PresetId, type Rect, type SnapTarget } from "@contracts/desk";
import { surface } from "@/components/app/surface";
import { LayoutMiniature } from "@/components/desk/LayoutPicker";
import { slotNames, targetName } from "@/lib/desk/targetName";
import { useSnapState, type SnapStore } from "@/lib/desk/useSnapDrag";

/** Where a target lies on the desk drawn (a share of it on each axis). */
function targetRect(target: SnapTarget, desk: DeskLayout, drawn: PresetId): Rect | undefined {
  return target.kind === "swap" ? slotRects(drawn, tracksOf(desk, drawn))[target.index] : slotRects(target.preset, tracksOf(desk, target.preset))[target.slot];
}

const targetKey = (target: SnapTarget) => (target.kind === "swap" ? `swap-${target.index}` : `${target.preset}-${target.slot}`);

/**
 * While a pane is moved (or an issue dragged in): where it would land, filled in the accent and
 * named, and the snap bar at the top (every arrangement for that many slots, each slot a place to
 * drop it; none with no room for one more). Only this redraws as the pointer moves.
 */
export function SnapOverlay({ store, desk, drawn }: { store: SnapStore; desk: DeskLayout; drawn: PresetId }) {
  const drag = useSnapState(store);
  if (!drag) return null;
  const target = drag.target;
  const rect = target && targetRect(target, desk, drawn);
  const keys = slotNames(desk.panes);
  const bar = presetsFor(drag.places);
  return (
    <div aria-hidden data-snap-overlay className="pointer-events-none absolute inset-0 z-30">
      {target && rect && (
        // surface: none — a highlight drawn over the panes for the length of a drag, not a box.
        <div
          key={targetKey(target)}
          className="absolute flex items-center justify-center rounded-lg bg-primary-soft/80 ring-2 ring-inset ring-ring duration-DEFAULT animate-in fade-in-0"
          style={{
            left: `calc(${rect.x * 100}% + 6px)`,
            top: `calc(${rect.y * 100}% + 6px)`,
            width: `calc(${rect.w * 100}% - 12px)`,
            height: `calc(${rect.h * 100}% - 12px)`,
          }}
        >
          <span {...surface("chip")} className="max-w-[80%] truncate rounded-md border bg-card px-2.5 py-1 text-body-sm font-medium text-foreground shadow-xs first-letter:uppercase">
            {targetName(target, keys)}
          </span>
        </div>
      )}
      {/* The snap bar: its slots are found under the pointer (pointer events on), never clicked. */}
      {/* Centred by a row, not a transform: the fade's own transform would move it while it appears. */}
      {bar.length > 0 && (
        <div className="absolute inset-x-0 top-3 flex justify-center">
          <div {...surface("menu")} className="pointer-events-auto flex items-center gap-2 rounded-lg border bg-popover p-2 shadow-sm duration-DEFAULT animate-in fade-in-0">
            {bar.map(preset => (
              <LayoutMiniature
                key={preset}
                preset={preset}
                targets
                active={target?.kind === "slot" && target.preset === preset ? target.slot : null}
                className="h-9 w-14"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
