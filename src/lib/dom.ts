/** True when keyboard focus is in a text field (hotkeys must not fire). */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

/** True while a modal dialog is open (page hotkeys must not fire). */
export function isDialogOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'
    ) !== null
  );
}

/** True when the key comes from inside a floating panel, the pinboard or the TODO list (the page behind must not act on it). */
export function inFloat(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-pinboard-float], [data-todo-float]") !== null;
}

/** The user asks for less motion: no smooth scrolls, no counting numbers. */
export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The platform's command key, as shortcuts are written: ⌘ on Apple devices, Ctrl elsewhere. */
export const MOD_KEY = APPLE ? "⌘" : "Ctrl";

/** "Back" by keyboard, as the platform has it. */
export const BACK_KEYS = APPLE ? "⌘[" : "Alt+←";

/** Shortcut label for the command palette, per platform. */
export const PALETTE_SHORTCUT =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘K"
    : "Ctrl K";
