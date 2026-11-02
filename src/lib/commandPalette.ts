import { useEffect, useSyncExternalStore } from "react";
import { isDialogOpen } from "@/lib/dom";

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
    () => open,
    () => open
  );
}

/** ⌘K / Ctrl+K: in the first load, so a key pressed at once is never lost (the palette's body comes later). */
export function useCommandPaletteShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Never stack on another dialog (QuickStart, focus, log time…).
        if (!commandPalette.isOpen() && isDialogOpen()) return;
        commandPalette.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
