import { useEffect } from "react";
import { isDialogOpen } from "@/lib/dom";
import { createFlag } from "@/lib/flag";

/** Open/close the global command palette from anywhere. */
export const commandPalette = createFlag();

const isShortcut = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";

// Pressed before the app took the page over (a slow machine leaves the server's page without React a while).
// Only that while: a page without the palette (sign-in) gives the key back to the browser after it.
const EARLY_MS = 10_000;
let pressedAt = -Infinity;
const early = (e: KeyboardEvent) => {
  if (!isShortcut(e)) return;
  e.preventDefault();
  pressedAt = performance.now();
};

/** From the page's first script on: ⌘K / Ctrl+K pressed before the app has mounted opens the palette once it has. */
export function holdCommandPaletteShortcut() {
  window.addEventListener("keydown", early);
  setTimeout(() => window.removeEventListener("keydown", early), EARLY_MS);
}

/** ⌘K / Ctrl+K: in the first load, so a key pressed at once is never lost (the palette's body comes later). */
export function useCommandPaletteShortcut() {
  useEffect(() => {
    const toggle = () => {
      // Never stack on another dialog (QuickStart, focus, log time…).
      if (!commandPalette.get() && isDialogOpen()) return;
      commandPalette.toggle();
    };
    const onKey = (e: KeyboardEvent) => {
      if (isShortcut(e)) {
        e.preventDefault();
        toggle();
      }
    };
    window.removeEventListener("keydown", early);
    if (performance.now() - pressedAt < EARLY_MS) toggle();
    pressedAt = -Infinity;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
