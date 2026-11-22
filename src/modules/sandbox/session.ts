/**
 * A framed module's session store: a few short strings that last as long as
 * the tab (a reload keeps them), for what happens once a session. The host
 * keeps them in its own sessionStorage under the module's name (a sandboxed
 * frame has none), and drops them all when someone signs in or out.
 */

import { onSessionEnd } from "@/lib/accountData";

export const SESSION_KEY_MAX = 64;
export const SESSION_VALUE_MAX = 4096;
/** Keys per module. */
export const SESSION_KEYS_MAX = 32;

const PREFIX = "ikl-module-session:";

export type SessionBackend = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function createSessionStore(backend: () => SessionBackend | null) {
  const at = (moduleId: string, key: string) => `${PREFIX}${moduleId}:${key}`;
  // Storage that throws (blocked, full) is no session store: reads are empty, writes are lost.
  const keys = (prefix: string) => {
    const b = backend();
    const out: string[] = [];
    if (!b) return out;
    for (let i = 0; i < b.length; i++) {
      const k = b.key(i);
      if (k?.startsWith(prefix)) out.push(k);
    }
    return out;
  };
  const quiet = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return {
    get: (moduleId: string, key: string): string | null => quiet(() => backend()?.getItem(at(moduleId, key)) ?? null, null),
    set(moduleId: string, key: string, value: string) {
      const k = at(moduleId, key);
      const b = quiet(backend, null);
      if (!b) return;
      if (quiet(() => b.getItem(k), null) === null && quiet(() => keys(`${PREFIX}${moduleId}:`).length, 0) >= SESSION_KEYS_MAX) throw new Error("session: too many keys");
      quiet(() => b.setItem(k, value), undefined);
    },
    delete: (moduleId: string, key: string) => quiet(() => backend()?.removeItem(at(moduleId, key)), undefined),
    /** Signed out: no module's session outlives it. */
    clear: () => quiet(() => keys(PREFIX).forEach(k => backend()?.removeItem(k)), undefined),
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;

const browserSession = () => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};

/** The page's session store (the browser's sessionStorage). */
export const moduleSessions = createSessionStore(browserSession);
// Signing in or out: the next account on this tab starts with none.
onSessionEnd(moduleSessions.clear);
