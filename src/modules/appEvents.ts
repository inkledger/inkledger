// What the user just did, as the server confirmed it: told by the tRPC link
// (src/providers/trpc.tsx) the moment a mutation succeeds, heard by the
// module host (host.ts), which turns it into host events. Nothing is guessed
// from caches here: a log is a log, an edit an edit.
import type { HostEvents } from "./types";

type AppEvents = Pick<HostEvents, "worklog-logged" | "worklog-changed" | "timer-stopped">;
type Listener = <E extends keyof AppEvents>(event: E, detail: AppEvents[E]) => void;

const listeners = new Set<Listener>();

export function onAppEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitAppEvent<E extends keyof AppEvents>(event: E, detail: AppEvents[E]) {
  for (const fn of listeners) fn(event, detail);
}

type Ref = { connectionId: number; key: string };
type Saved = { issueKey?: unknown; connectionId?: unknown; timeSpentSeconds?: unknown };

const refOf = (row: Saved): Ref | undefined =>
  typeof row.issueKey === "string" && typeof row.connectionId === "number" ? { connectionId: row.connectionId, key: row.issueKey } : undefined;

/**
 * A mutation the server answered: the events it means. Inputs and outputs
 * are read defensively (the link sees every procedure).
 */
export function eventsOf(path: string, input: unknown, output: unknown) {
  const out = (output ?? {}) as Saved & { seconds?: unknown; found?: unknown; previousSeconds?: unknown };
  const inp = (input ?? {}) as { issueKey?: unknown; connectionId?: unknown };
  switch (path) {
    case "worklogs.create": {
      const seconds = typeof out.timeSpentSeconds === "number" ? out.timeSpentSeconds : 0;
      if (seconds > 0) emitAppEvent("worklog-logged", { seconds, ref: refOf(out) });
      return;
    }
    case "worklogs.update": {
      const seconds = typeof out.timeSpentSeconds === "number" ? out.timeSpentSeconds : 0;
      const before = typeof out.previousSeconds === "number" ? out.previousSeconds : seconds;
      emitAppEvent("worklog-changed", { seconds: seconds - before, ref: refOf(out) });
      return;
    }
    case "worklogs.delete": {
      const gone = typeof out.seconds === "number" ? out.seconds : 0;
      emitAppEvent("worklog-changed", { seconds: -gone, ref: refOf(out) });
      return;
    }
    case "timers.stop":
      if (out.found === true && typeof inp.issueKey === "string") {
        emitAppEvent("timer-stopped", {
          issueKey: inp.issueKey,
          seconds: typeof out.seconds === "number" ? out.seconds : 0,
          ref: typeof inp.connectionId === "number" ? { connectionId: inp.connectionId, key: inp.issueKey } : undefined,
        });
      }
      return;
  }
}
