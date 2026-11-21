import { removeStoredPrefix } from "@/lib/storage";
import { forgetAllFolders } from "@/lib/desk/folders";
import { pinboardBoard } from "@/hooks/usePinboardPanel";
import { forgetCollapsedSaves } from "@/hooks/useCollapsedColumns";

/** Where a timer's note waits on this device after a failed save: `<prefix><connection>:<issue key>`. */
export const TIMER_NOTE_DRAFT_PREFIX = "ikl.timerNote.";

/** Resets registered by parts loaded on demand (the Desk chat), so the shell never has to load them. */
const sessionResets = new Set<() => void>();

/** Runs `reset` whenever an account's session ends on this page (a sign-out, another way in). */
export function onSessionEnd(reset: () => void): void {
  sessionResets.add(reset);
}

/**
 * What this page holds of the account outside the query cache, dropped on every way in: the next
 * account (another person, on the same tab) must never see the Desk chat or build on a pending save.
 */
export function forgetSessionState(): void {
  forgetCollapsedSaves();
  sessionResets.forEach(reset => reset());
}

/**
 * Signing out: also what this device keeps of the account: the folders connected for the Desk,
 * timer notes waiting to be saved, the board the pinboard panel shows. (Note drafts are kept per
 * user and only shown to their author.)
 */
export function forgetAccountData(): void {
  forgetSessionState();
  forgetAllFolders();
  removeStoredPrefix(TIMER_NOTE_DRAFT_PREFIX);
  pinboardBoard.forget();
}
