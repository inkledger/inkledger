import type { TimerConflict } from "@contracts/timerLock";

/** The cause of a CONFLICT on a timer: its details reach the page (errorFormatter). */
export class TimerConflictError extends Error {
  readonly info: TimerConflict;
  constructor(info: TimerConflict) {
    super(`timer ${info.reason}`);
    this.info = info;
  }
}
