import { createStore } from "@/lib/store";

/**
 * The framed module whose sheet is open ("sheet"), one at a time: the host
 * owns the dialog (focus, Esc, the page made inert), the module draws in a
 * view frame inside it. Only the module that opened it closes it.
 */
const open = createStore<string | null>(null);

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
  open: (moduleId: string) => open.set(moduleId),
  close(moduleId?: string) {
    if (moduleId === undefined || open.get() === moduleId) open.set(null);
  },
};
