import { useSyncExternalStore } from "react";

/** A global open/closed flag (dialogs opened from anywhere: keys, palette, toasts). */
export function createFlag() {
  let value = false;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  return {
    set: (next: boolean) => {
      value = next;
      listeners.forEach(l => l());
    },
    useValue: (): boolean => {
      return useSyncExternalStore(subscribe, () => value, () => value);
    },
    get: () => value,
    subscribe,
  };
}

/** "Close the day" sheet. */
export const dayReview = createFlag();
/** Full-screen focus mode of the running timer. */
export const focusMode = createFlag();
/** The screensaver (key "z", the palette, the sidebar, More on phones). */
export const screensaver = createFlag();
/** "Pin a mail" from anywhere (palette, a mail dropped or pasted on the app): it asks where. */
export const pinMailDialog = createFlag();
/** "New issue" dialog (key i, palette, Issues page). */
export const createIssueDialog = createFlag();
/** Notification center (right-side panel, like macOS). */
export const notificationCenter = createFlag();
/** The floating pinboard widget, opened from the sidebar, "p" or the palette. */
export const pinboardFloat = createFlag();
/** Set when the user opens the widget: it takes the focus then (not when it comes back on another page). */
export const pinboardFloatFocus = createFlag();
/** The floating TODO list, opened with "d", the hot corner, the palette or its buttons. */
export const todoFloat = createFlag();
/** Set when the user opens it: it takes the focus then (its capture field). */
export const todoFloatFocus = createFlag();
/** The Board's pinboard sheet on small screens. */
export const pinboardSheet = createFlag();
