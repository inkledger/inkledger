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
      return useSyncExternalStore(subscribe, () => value);
    },
    get: () => value,
    subscribe,
  };
}

/** "Close the day" sheet. */
export const dayReview = createFlag();
/** Full-screen focus mode of the running timer. */
export const focusMode = createFlag();
/** "New issue" dialog (key i, palette, Issues page). */
export const createIssueDialog = createFlag();
/** Notification center (right-side panel, like macOS). */
export const notificationCenter = createFlag();
/** Pinboard as a dialog, opened from the sidebar or "p" outside the Board. */
export const pinboardDialog = createFlag();
/** The Board's pinboard sheet on small screens. */
export const pinboardSheet = createFlag();
