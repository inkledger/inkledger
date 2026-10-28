// What leaves the server, for Settings → Network: every outgoing fetch is
// counted by host (trackers, Microsoft, GitHub, the weather, the module store,
// anything added later), whoever made it. Hosts only, never a path, a query or
// a body. Counted in memory and written every half minute: a call never waits
// on the database.
import { sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { egressHosts } from "@db/schema";

type Tally = { calls: number; failures: number; lastStatus: string; firstAt: number; lastAt: number };
const pending = new Map<string, Tally>();

const FLUSH_MS = 30_000;
/** The server's own neighbours are not "leaving": loopback is not counted. */
const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

/** The host a fetch goes to (with its port when not the default), or null for a relative or local one. */
export function egressHost(input: string | URL | Request): string | null {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return LOCAL.test(url.host) ? null : url.host.toLowerCase();
}

/** One call to `host`: its answer's status, or "error" when none came. */
export function noteEgress(host: string, status: number | "error", now = Date.now()): void {
  const failed = status === "error" || status >= 400;
  const t = pending.get(host);
  if (t) {
    t.calls++;
    if (failed) t.failures++;
    t.lastStatus = String(status);
    t.lastAt = now;
  } else pending.set(host, { calls: 1, failures: failed ? 1 : 0, lastStatus: String(status), firstAt: now, lastAt: now });
}

/** Writes what was counted since the last time (added to what is stored). */
export async function flushEgress(): Promise<void> {
  if (pending.size === 0) return;
  const rows = [...pending].map(([host, t]) => ({ host, ...t, firstAt: new Date(t.firstAt), lastAt: new Date(t.lastAt) }));
  pending.clear();
  await getDb()
    .insert(egressHosts)
    .values(rows)
    .onConflictDoUpdate({
      target: egressHosts.host,
      set: {
        calls: sql`${egressHosts.calls} + excluded.calls`,
        failures: sql`${egressHosts.failures} + excluded.failures`,
        lastStatus: sql`excluded.last_status`,
        firstAt: sql`LEAST(${egressHosts.firstAt}, excluded.first_at)`,
        lastAt: sql`GREATEST(${egressHosts.lastAt}, excluded.last_at)`,
      },
    });
}

const g = globalThis as { __iklEgress?: { timer: ReturnType<typeof setInterval> } };

/**
 * Counts every fetch this process makes from now on. Once per process (the
 * dev server evaluates the app again on each change).
 */
export function installEgressLog({ underTests = false } = {}): void {
  // The unit tests stub fetch and read its calls: left alone unless a test asks.
  if (g.__iklEgress || (process.env.VITEST && !underTests)) return;
  const original = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const host = egressHost(input);
    try {
      const res = await original(input, init);
      if (host) noteEgress(host, res.status);
      return res;
    } catch (e) {
      if (host) noteEgress(host, "error");
      throw e;
    }
  };
  const timer = setInterval(() => void flushEgress().catch((e: unknown) => console.warn(`[egress] ${String(e)}`)), FLUSH_MS);
  timer.unref();
  g.__iklEgress = { timer };
}
