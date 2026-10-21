import { useEffect } from "react";

const TOUCH = "(hover: none)";

function editable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLSelectElement) return true;
  return (
    el instanceof HTMLInputElement &&
    !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(el.type)
  );
}

/**
 * On touch screens, marks <html data-keyboard> while a text field has focus:
 * the soft keyboard is up, so the tab bar steps aside (some WebViews resize
 * the page and would lift it over the field being typed in).
 */
export function useSoftKeyboard() {
  useEffect(() => {
    const root = document.documentElement;
    const sync = () => {
      const up = window.matchMedia(TOUCH).matches && editable(document.activeElement);
      if (up) root.dataset.keyboard = "";
      else delete root.dataset.keyboard;
    };
    // focusout fires before the next field gets focus: look after it lands.
    const later = () => requestAnimationFrame(sync);
    document.addEventListener("focusin", sync);
    document.addEventListener("focusout", later);
    return () => {
      document.removeEventListener("focusin", sync);
      document.removeEventListener("focusout", later);
      delete root.dataset.keyboard;
    };
  }, []);
}
