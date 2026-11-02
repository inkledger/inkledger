import { useEffect, useRef, type PointerEvent } from "react";
import { useNavigate } from "react-router";
import { deskIssues, DESK_MAX_PANES, pagePresets, paneId, placeIssue, type DeskPane, type PresetId } from "@contracts/desk";
import { trpc } from "@/lib/trpc";
import { isDialogOpen, isTyping, MOD_KEY } from "@/lib/dom";
import { sendToDesk } from "@/lib/desk/send";
import { layoutLabel } from "@/lib/desk/grid";
import { placeOf, placeShortName } from "@/lib/desk/targetName";

export const WIDE = "(min-width: 1024px)";
/** Alt+Shift (⌥⇧ on Apple): with an arrow, the issue goes to that half of the desk. */
export const DESK_KEYS = MOD_KEY === "⌘" ? "⌥⇧" : "Alt+Shift";
const EDGE_KEYS: Partial<Record<string, [PresetId, number]>> = { ArrowLeft: ["cols-2", 0], ArrowRight: ["cols-2", 1], ArrowUp: ["rows-2", 0], ArrowDown: ["rows-2", 1] };
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 10;

/** Where a slot goes, said in full: "right half (Side by side)". */
export const slotLabel = (preset: PresetId, slot: number) => `${placeShortName(placeOf(preset, slot))} (${layoutLabel(preset)})`;

/**
 * Sending an issue's page to the Desk: the arrangements with room for it beside the desk's
 * issues (read from the cache; fetched ahead on the way to a control), and the send itself:
 * this issue in the slot chosen, the desk's others where they fit, then the Desk.
 */
export function useSendToDesk(pane: DeskPane) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  // The desk as already read: never a request of its own on the page (prefetch below).
  const desk = trpc.desks.current.useQuery(undefined, { enabled: false }).data;
  const others = desk ? deskIssues(desk).filter(item => paneId(item) !== paneId(pane)).length : 0;
  // At least two places: an issue sent alone keeps an empty slot beside it to open another in.
  const n = Math.min(Math.max(others + 1, 2), DESK_MAX_PANES);
  return {
    n,
    presets: pagePresets(n),
    prefetch: () => void utils.desks.current.prefetch(undefined, { staleTime: 30_000 }),
    send: (preset: PresetId, slot: number) => void sendToDesk({ utils, navigate }, d => placeIssue(d, pane, preset, slot)),
  };
}

/**
 * A long press on the title (a phone): `onPress` after half a second held still. Moving (a
 * scroll) or letting go earlier is no press; the menu the browser would open is not shown then.
 */
export function useLongPress(onPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLHeadingElement>) => {
      if (e.button !== 0 || window.matchMedia(WIDE).matches) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        fired.current = true;
        start.current = null;
        window.getSelection()?.removeAllRanges();
        onPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent<HTMLHeadingElement>) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > LONG_PRESS_SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent<HTMLHeadingElement>) => {
      if (fired.current) e.preventDefault();
    },
  };
}

/** Alt+Shift+arrows on an issue's page: the issue to that half of the desk (the desk's first issue in the other). */
export function useDeskKeys(pane: DeskPane | null) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const latest = useRef({ pane, utils, navigate });
  useEffect(() => {
    latest.current = { pane, utils, navigate };
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const edge = EDGE_KEYS[e.key];
      if (!edge || !e.altKey || !e.shiftKey || e.metaKey || e.ctrlKey || e.defaultPrevented || isTyping(e.target) || isDialogOpen()) return;
      const { pane: current, ...context } = latest.current;
      if (!current) return;
      e.preventDefault();
      void sendToDesk(context, d => placeIssue(d, current, edge[0], edge[1]));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

