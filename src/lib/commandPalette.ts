import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Open/close the global command palette from anywhere. */
export const commandPalette = {
  set: (value: boolean) => {
    open = value;
    emit();
  },
  toggle: () => {
    open = !open;
    emit();
  },
  isOpen: (): boolean => {
    return open;
  },
};

export function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open
  );
}
