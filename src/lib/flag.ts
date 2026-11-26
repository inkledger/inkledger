import { createStore } from "@/lib/store";
import type { FeedbackType } from "@contracts/feedback";

/** A global open/closed flag (dialogs opened from anywhere: keys, palette, toasts). */
export function createFlag() {
  const { get, set, use, subscribe } = createStore(false);
  return { set, useValue: use, get, toggle: () => set(!get()), subscribe };
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
/** "Open the notifications" from anywhere (the bell, "n", a toast, More on phones): leads to their page. */
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
/** "New idea" (the palette): a small capture of ideas from anywhere. */
export const ideaCapture = createFlag();

/** What "Send feedback" opens with: its kind and words already there ("Report" on an error). */
export type FeedbackDraft = { type?: FeedbackType; body?: string };
/** "Send feedback" (the account menu, ⌘K, "Report" on an error): null while closed. */
export const feedbackSheet = createStore<FeedbackDraft | null>(null);
/** Opens "Send feedback" from anywhere. */
export const openFeedback = (draft: FeedbackDraft = {}) => feedbackSheet.set(draft);
