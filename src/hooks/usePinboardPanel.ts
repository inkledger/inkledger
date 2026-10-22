import { deviceSetting } from "@/lib/storage";
import { pinboardDialog, pinboardSheet } from "@/lib/flag";

export type PinboardPanel = "closed" | "open" | "wide";
const panel = deviceSetting<PinboardPanel>("ikl-pinboard-panel", raw => (raw === "open" || raw === "wide" ? raw : "closed"));

/** The Board's pinboard panel: closed, open or wide (per device). */
export const pinboardPanel = {
  set: (next: PinboardPanel) => panel.set(next),
};

/**
 * Sidebar button and "p": on the Board, its own panel (wide screens) or sheet;
 * anywhere else, the pinboard as a dialog.
 */
export function togglePinboard(pathname = window.location.pathname) {
  if (pathname !== "/board") {
    pinboardDialog.set(true);
  } else if (window.matchMedia("(min-width: 1024px)").matches) {
    pinboardPanel.set(panel.get() === "closed" ? "open" : "closed");
  } else {
    pinboardSheet.set(true);
  }
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
