import { useSyncExternalStore } from "react";

/**
 * The page's line to /api/events: what changed for the user elsewhere (a
 * timer started on the phone) arrives at once. One stream per tab, opened by
 * AppLayout. While it is down the timers poll faster, and the page says its
 * view may be behind.
 *   live        — connected
 *   connecting  — reconnecting (the browser retries by itself)
 *   offline     — no network
 */
export type LiveState = "live" | "connecting" | "offline";

type Listener = () => void;
const listeners = new Set<Listener>();
let state: LiveState = "connecting";
/** When the server was last heard from (event or open), epoch ms. */
let heardAt = 0;

const set = (next: LiveState) => {
  if (next === "live") heardAt = Date.now();
  if (next === state) return;
  state = next;
  listeners.forEach(l => l());
};

export const liveEvents = {
  get: () => state,
  heardAt: () => heardAt,
  /** Opens the stream; `on` gets each event's name. Returns the closer. */
  open(on: (type: string) => void): () => void {
    if (typeof EventSource === "undefined") {
      set("offline");
      return () => undefined;
    }
    const src = new EventSource("/api/events");
    const heard = (type: string) => () => {
      set("live");
      on(type);
    };
    src.addEventListener("hello", heard("hello"));
    src.addEventListener("timers", heard("timers"));
    src.onopen = () => set("live");
    src.onerror = () => set(navigator.onLine === false ? "offline" : "connecting");
    const offline = () => set("offline");
    const online = () => set("connecting");
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      src.close();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  },
};

export function useLiveState(): LiveState {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
