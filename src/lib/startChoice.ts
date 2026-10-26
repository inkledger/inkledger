import { useSyncExternalStore } from "react";
import type { TimeSpan } from "@contracts/time";

/** A timer about to start while a hole is open: from now, or from the hole's start. */
export type StartChoice = {
  input: { issueKey: string; connectionId?: number };
  gap: TimeSpan;
  announce: boolean;
};

let pending: StartChoice | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The choice asked of the user before a Play (one at a time, the last one wins). */
export const startChoice = {
  ask(next: StartChoice | null) {
    pending = next;
    listeners.forEach(l => l());
  },
  use: (): StartChoice | null => useSyncExternalStore(subscribe, () => pending, () => pending),
};
