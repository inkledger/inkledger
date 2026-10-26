import { useSyncExternalStore } from "react";

/**
 * This device's localStorage, for conveniences only (a layout, a folded section, a choice
 * remembered): never for what must survive or reach another device. Every access survives
 * its absence: private browsing, blocked site data, a sandboxed frame, a full quota.
 */

/** The stored text, or null: nothing stored, or no storage to read. */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores `value` (null removes it). False when the browser refused (no storage, quota full): the caller's value still holds in memory. */
export function writeStored(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** JSON stored under `key`, or undefined: nothing stored, no storage, or not JSON. The caller checks its shape. */
export function readStoredJson(key: string): unknown {
  const raw = readStored(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A setting of this device, shared by every component that reads it: read once at start,
 * `parse` turning what is stored (null when nothing or unreadable) into a valid value, so
 * malformed data falls back to its default. `set` changes it for this page at once and
 * stores `format(value)` (null removes the key); a refused write leaves it for this visit.
 * Another tab's change applies here on the next load, not live.
 */
export function deviceSetting<T>(key: string, parse: (raw: string | null) => T, format: (value: T) => string | null = String) {
  let value = parse(readStored(key));
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  return {
    get: (): T => value,
    set(next: T) {
      value = next;
      writeStored(key, format(next));
      listeners.forEach(l => l());
    },
    use: (): T => useSyncExternalStore(subscribe, () => value, () => value),
  };
}
