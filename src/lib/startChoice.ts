import { createStore } from "@/lib/store";
import type { TimeSpan } from "@contracts/time";

/** A timer about to start while a hole is open: from now, or from the hole's start. */
export type StartChoice = {
  input: { issueKey: string; connectionId?: number };
  gap: TimeSpan;
  announce: boolean;
};

const pending = createStore<StartChoice | null>(null);

/** The choice asked of the user before a Play (one at a time, the last one wins). */
export const startChoice = {
  ask: pending.set,
  use: pending.use,
};
