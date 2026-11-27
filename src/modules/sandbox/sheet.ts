import { createStore } from "@/lib/store";

/**
 * The framed module whose sheet is open ("sheet"), one at a time: the host
 * owns the dialog (focus, Esc, the page made inert), the module draws in a
 * view frame inside it. Only the module that opened it closes it.
 */
const open = createStore<string | null>(null);
/** How it opens: "side" (the side sheet) or "wide" (a centered dialog, the whole screen on a phone). */
export type SheetSize = "side" | "wide";
// Kept as it closes: the dialog fading out stays the one that opened.
const size = createStore<SheetSize>("side");
// The box of the view that opened it: the focus goes back there as it closes.
let opener: HTMLElement | null = null;

// Each request to close the phone's More sheet (from a module row in it): the tab bar listens.
const moreCloses = createStore(0);

export const mobileMore = {
  close: () => moreCloses.set(moreCloses.get() + 1),
  /** Calls `fn` on each request; returns the undo. */
  onClose: (fn: () => void) => moreCloses.subscribe(fn),
};

export const sheetOpen = {
  get: open.get,
  use: open.use,
  subscribe: open.subscribe,
  size: size.get,
  useSize: size.use,
  open(moduleId: string, from?: HTMLElement | null, as: SheetSize = "side") {
    opener = from ?? null;
    size.set(as);
    open.set(moduleId);
  },
  /** The opener's box, once (null when none was told or it left the page). */
  takeOpener() {
    const el = opener;
    opener = null;
    return el?.isConnected ? el : null;
  },
  close(moduleId?: string) {
    if (moduleId === undefined || open.get() === moduleId) open.set(null);
  },
};
