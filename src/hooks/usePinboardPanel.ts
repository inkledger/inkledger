import { useSyncExternalStore } from "react";
import { pinboardDialog, pinboardSheet } from "@/lib/flag";

export type PinboardPanel = "closed" | "open" | "wide";
const KEY = "ikl-pinboard-panel";
const listeners = new Set<() => void>();

function read(): PinboardPanel {
  try {
    const v = localStorage.getItem(KEY);
    return v === "open" || v === "wide" ? v : "closed";
  } catch {
    return "closed";
  }
}

let state = read();

/** The Board's pinboard panel: closed, open or wide (per device). */
export const pinboardPanel = {
  set: (next: PinboardPanel) => {
    state = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable: applies for this session */
    }
    listeners.forEach(l => l());
  },
};

/**
 * Sidebar button and "p": on the Board, its own panel (wide screens) or sheet;
 * anywhere else, the pinboard as a dialog.
 */
export function togglePinboard(pathname = window.location.pathname) {
  if (pathname !== "/board") {
    pinboardDialog.set(true);
  } else if (window.matchMedia("(min-width: 1024px)").matches) {
    pinboardPanel.set(state === "closed" ? "open" : "closed");
  } else {
    pinboardSheet.set(true);
  }
}

export function usePinboardPanel(): PinboardPanel {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state
  );
}

const BOARD_KEY = "ikl-pinboard-board";
const boardListeners = new Set<() => void>();

function readBoard(): number | null {
  try {
    const v = Number(localStorage.getItem(BOARD_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

let boardId = readBoard();

/** The board shown in the panel (and where "Pin" pins), per device. */
export const pinboardBoard = {
  set: (id: number) => {
    boardId = id;
    try {
      localStorage.setItem(BOARD_KEY, String(id));
    } catch {
      /* storage unavailable: applies for this session */
    }
    boardListeners.forEach(l => l());
  },
  get: () => boardId,
};

export function usePinboardBoardId(): number | null {
  return useSyncExternalStore(
    l => {
      boardListeners.add(l);
      return () => boardListeners.delete(l);
    },
    () => boardId
  );
}
