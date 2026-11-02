import { useEffect } from "react";
import { isDialogOpen } from "@/lib/dom";
import { createFlag } from "@/lib/flag";

/** Open/close the global command palette from anywhere. */
export const commandPalette = createFlag();

/** ⌘K / Ctrl+K: in the first load, so a key pressed at once is never lost (the palette's body comes later). */
export function useCommandPaletteShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        // Never stack on another dialog (QuickStart, focus, log time…).
        if (!commandPalette.get() && isDialogOpen()) return;
        commandPalette.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
