// A user's time writes one at a time across every server process on this
// database (write_leases): an overlap check, a closed week or a timer's time
// read, then written, never interleaved with another process's write. The
// in-process lock goes first (no polling between requests of one process).
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, lt } from "drizzle-orm";
import { writeLeases } from "@db/schema";
import { t } from "@contracts/i18n";
import { keyedLock } from "../lib/locks";
import { getDb } from "./connection";

/** Longer than any write takes (each tracker call has its own 30 s timeout): a holder past it died. */
export const WRITE_LEASE_MS = 2 * 60_000;
/** How long a write waits for another process's before giving up. */
const WAIT_MS = 45_000;

const local = keyedLock<number>();

async function acquire(userId: number, holder: string): Promise<void> {
  const db = getDb();
  const until = Date.now() + WAIT_MS;
  for (let pause = 20; ; pause = Math.min(pause * 2, 250)) {
    const now = Date.now();
    const [got] = await db
      .insert(writeLeases)
      .values({ userId, holder, expiresAt: now + WRITE_LEASE_MS })
      .onConflictDoUpdate({ target: writeLeases.userId, set: { holder, expiresAt: now + WRITE_LEASE_MS }, setWhere: lt(writeLeases.expiresAt, now) })
      .returning({ holder: writeLeases.holder });
    if (got?.holder === holder) return;
    if (Date.now() + pause > until) throw new TRPCError({ code: "TIMEOUT", message: t("server.worklogs.busy") });
    await new Promise((r) => setTimeout(r, pause));
  }
}

/** Runs `fn` holding the user's write lease: no other write of theirs, in any process, meanwhile. */
export function withWriteLease<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  return local(userId, async () => {
    const holder = randomUUID();
    await acquire(userId, holder);
    try {
      return await fn();
    } finally {
      await getDb()
        .delete(writeLeases)
        .where(and(eq(writeLeases.userId, userId), eq(writeLeases.holder, holder)))
        .catch((e: unknown) => console.error(e));
    }
  });
}
