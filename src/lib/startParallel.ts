import { createStore } from "@/lib/store";
import { deviceSetting } from "@/lib/storage";

/** How a timer starts while others run: pausing them, or beside them. */
export type StartMode = "switch" | "alongside";

/** Play while other timers run: switch to it, or run it beside them. */
export type StartParallel = {
  input: { issueKey: string; connectionId?: number };
  /** The timers running now, as read when Play was pressed */
  running: { issueKey: string; connectionId: number; elapsedSeconds: number }[];
  announce: boolean;
};

const pending = createStore<StartParallel | null>(null);

/** The choice asked before a Play while timers run (one at a time, the last one wins). */
export const startParallel = {
  ask: pending.set,
  use: pending.use,
};

/** The answer last given on this device: Enter gives it again. */
export const lastStartMode = deviceSetting<StartMode>("ikl-timer-start-mode", raw => (raw === "alongside" ? "alongside" : "switch"));
