import { useSyncExternalStore } from "react";
import { quickStart } from "@/lib/quickStart";
import { issueId } from "@/lib/issues";
import { t } from "@contracts/i18n";

/** A stopped timer whose time still has to be logged. */
export type PendingTimerLog = {
  issueKey: string;
  /** The issue's connection (a key may live on two). */
  connectionId?: number;
  seconds: number;
  note?: string;
  /** Default true: logging a stopped timer clears it once saved. */
  fromTimer?: boolean;
  /** Fixed start (e.g. away time assigned to another issue). */
  start?: Date;
  /** When the timer was stopped: the block ends there, not when logged. */
  end?: Date;
  /** A timer whose tracked time this block comes from (not a collision). */
  excludeTimer?: string;
  /** Runs once the worklog is saved (not when the dialog is dismissed). */
  onSaved?: () => void;
};

let queue: PendingTimerLog[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

/** App-wide queue: one dialog (TimerLogHost) asks to log each stopped timer. */
export const timerLog = {
  push(entry: PendingTimerLog) {
    // A newer stop of the same timer replaces its request; other requests
    // (a hole, away time) never drop a timer's.
    const isTimer = (q: PendingTimerLog) => q.fromTimer ?? true;
    queue = [
      ...queue.filter(
        // The same timer: its key on its connection (a key may live on two).
        q => !(isTimer(q) && isTimer(entry) && issueId(q) === issueId(entry))
      ),
      entry,
    ];
    emit();
  },
  shift() {
    queue = queue.slice(1);
    emit();
  },
  /** Signed in again (maybe as someone else): the old requests are not theirs. */
  clear() {
    queue = [];
    emit();
  },
};

export function useTimerLogQueue(): PendingTimerLog[] {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => queue
  );
}

/**
 * A free span of the day (a hole): choose the issue, then the usual dialog
 * opens with start and duration filled in (and checked against the day).
 */
export function logSpan(
  start: Date,
  seconds: number,
  placeholder = t("ui.timerLog.spanPlaceholder")
) {
  quickStart.pick(
    ({ key, connectionId }) =>
      timerLog.push({ issueKey: key, connectionId, seconds, fromTimer: false, start }),
    placeholder
  );
}
