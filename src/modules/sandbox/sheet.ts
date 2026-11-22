import { createStore } from "@/lib/store";

/**
 * The framed module whose sheet is open ("sheet"), one at a time: the host
 * owns the dialog (focus, Esc, the page made inert), the module draws in a
 * view frame inside it. Only the module that opened it closes it.
 */
const open = createStore<string | null>(null);

export const sheetOpen = {
  get: open.get,
  use: open.use,
  open: (moduleId: string) => open.set(moduleId),
  close(moduleId?: string) {
    if (moduleId === undefined || open.get() === moduleId) open.set(null);
  },
};
