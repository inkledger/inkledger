import { useEffect, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { deviceSetting } from "@/lib/storage";
import { pinboardFloat, pinboardFloatFocus, pinboardSheet } from "@/lib/flag";
import { trpc } from "@/lib/trpc";

export type PinboardPanel = "closed" | "open" | "wide";
const panel = deviceSetting<PinboardPanel>("ikl-pinboard-panel", raw => (raw === "open" || raw === "wide" ? raw : "closed"));

/** The Board's pinboard panel: closed, open or wide (per device). */
export const pinboardPanel = {
  set: (next: PinboardPanel) => panel.set(next),
};

/** Where the pinboard lives (Settings → Pinboard): the Board's panel, its page in the menu, a floating widget. */
export type PinboardSurfaces = { board: boolean; menu: boolean; widget: boolean };
const ALL: PinboardSurfaces = { board: true, menu: true, widget: true };

let surfaces = ALL;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The user's surfaces, as their settings say (all of them until read). */
export function usePinboardSurfaces(): PinboardSurfaces {
  const s = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 }).data;
  return s ? { board: s.pinboardOnBoard === 1, menu: s.pinboardInMenu === 1, widget: s.pinboardWidget === 1 } : ALL;
}

/** Kept by the layout, so "p", the palette and the sidebar follow the settings outside React. */
export function setPinboardSurfaces(next: PinboardSurfaces) {
  if (next.board === surfaces.board && next.menu === surfaces.menu && next.widget === surfaces.widget) return;
  surfaces = next;
  listeners.forEach(l => l());
}

let go: ((to: string) => void) | null = null;

/** The layout's part: the settings and the router, for "p", the palette and the toasts. */
export function usePinboardWiring() {
  const s = usePinboardSurfaces();
  const navigate = useNavigate();
  useEffect(() => setPinboardSurfaces(s), [s.board, s.menu, s.widget]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    go = to => void navigate(to);
    return () => {
      go = null;
    };
  }, [navigate]);
}

export type PinboardTarget = "panel" | "sheet" | "float" | "page" | "board";

/**
 * Where "p" and the pinboard buttons open it: on the Board, its own panel (a
 * sheet on small screens) when that is on; else the floating widget; else its
 * page; else the Board with its panel. Never a second one where it already is
 * (its page), nothing when every place is off.
 */
export function pinboardTarget(pathname: string, wide: boolean, s: PinboardSurfaces): PinboardTarget | null {
  if (pathname === "/pinboard") return null;
  if (pathname === "/board" && s.board) return wide ? "panel" : "sheet";
  if (s.widget) return "float";
  if (s.menu) return "page";
  if (s.board) return "board";
  return null;
}

/** The widget gives way where the pinboard already is: its page, the Board with its panel. */
export const floatHidden = (pathname: string, s: PinboardSurfaces) => pathname === "/pinboard" || (pathname === "/board" && s.board);

/** The surfaces as the layout last gave them (setPinboardSurfaces). */
export const usePinboardSurfacesNow = (): PinboardSurfaces => useSyncExternalStore(subscribe, () => surfaces);

/** Opens the Board with its pinboard (panel, or sheet on small screens). */
function openOnBoard() {
  if (isWide()) pinboardPanel.set(panel.get() === "closed" ? "open" : panel.get());
  else pinboardSheet.set(true);
  go?.("/board");
}

const isWide = () => window.matchMedia("(min-width: 1024px)").matches;

/** Whether a pinboard button or key has somewhere to open it here. */
export function usePinboardTarget(pathname: string): PinboardTarget | null {
  return pinboardTarget(pathname, isWide(), usePinboardSurfacesNow());
}

/** Sidebar button, "p", palette, toasts: show or hide the pinboard where it lives (pinboardTarget). */
export function togglePinboard(pathname = window.location.pathname) {
  switch (pinboardTarget(pathname, isWide(), surfaces)) {
    case "panel":
      pinboardPanel.set(panel.get() === "closed" ? "open" : "closed");
      return;
    case "sheet":
      pinboardSheet.set(true);
      return;
    case "float":
      pinboardFloatFocus.set(!pinboardFloat.get());
      pinboardFloat.set(!pinboardFloat.get());
      return;
    case "page":
      go?.("/pinboard");
      return;
    case "board":
      openOnBoard();
      return;
    default:
  }
}

/** Whether "Open" after a pin has somewhere to open the pinboard (not where it already is, not when every place is off). */
export const canShowPinboard = (pathname = window.location.pathname) => pinboardTarget(pathname, isWide(), surfaces) !== null;

/** Show the pinboard where it lives (opening, never closing it): after a pin, "Open". */
export function showPinboard(pathname = window.location.pathname) {
  const target = pinboardTarget(pathname, isWide(), surfaces);
  if (target === "panel") pinboardPanel.set(panel.get() === "closed" ? "open" : panel.get());
  else if (target === "sheet") pinboardSheet.set(true);
  else if (target === "float") {
    pinboardFloatFocus.set(true);
    pinboardFloat.set(true);
  }
  else if (target === "page") go?.("/pinboard");
  else if (target === "board") openOnBoard();
}

export function usePinboardPanel(): PinboardPanel {
  return panel.use();
}

const board = deviceSetting<number | null>(
  "ikl-pinboard-board",
  raw => {
    const v = Number(raw);
    return Number.isInteger(v) && v > 0 ? v : null;
  },
  v => (v === null ? null : String(v)),
);

/** The board shown in the panel (and where "Pin" pins), per device. */
export const pinboardBoard = {
  set: (id: number) => board.set(id),
  get: () => board.get(),
};

export function usePinboardBoardId(): number | null {
  return board.use();
}
