import { useSyncExternalStore } from "react";

/**
 * A value of the whole app held outside React (a dialog asked for from anywhere, what the
 * layout last read for code outside React): `set` tells every component that reads it.
 */
export function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  return {
    get: (): T => value,
    set: (next: T) => {
      value = next;
      listeners.forEach(l => l());
    },
    use: (): T => useSyncExternalStore(subscribe, () => value, () => value),
    subscribe,
  };
}
