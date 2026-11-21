// A user's time writes one at a time across every server process on this
// database (write_leases): an overlap check, a closed week or a timer's time
// read, then written, never interleaved with another process's write. The
// in-process lock goes first (no polling between requests of one process).
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { TRPCError } from "@trpc/server";
import { and, eq, lt } from "drizzle-orm";
import { writeLeases } from "@db/schema";
import { t } from "@contracts/i18n";
import { keyedLock } from "../lib/locks";
import { getDb } from "./connection";

/**
 * The lease's length (a holder past it died), renewed every `beatMs` while its write runs:
 * a write of several tracker calls (30 s each at most) can outlast one lease, and another
 * process must never take it meanwhile. Tests shorten them.
 */
export const writeLeaseTiming = { leaseMs: 2 * 60_000, beatMs: 30_000 };
/** How long a write waits for another process's before giving up. */
const WAIT_MS = 45_000;

const local = keyedLock<number>();
const active = new AsyncLocalStorage<ReadonlySet<number>>();

async function acquire(userId: number, holder: string): Promise<void> {
  const db = getDb();
  const until = Date.now() + WAIT_MS;
  for (let pause = 20; ; pause = Math.min(pause * 2, 250)) {
    const now = Date.now();
    const [got] = await db
      .insert(writeLeases)
      .values({ userId, holder, expiresAt: now + writeLeaseTiming.leaseMs })
      .onConflictDoUpdate({ target: writeLeases.userId, set: { holder, expiresAt: now + writeLeaseTiming.leaseMs }, setWhere: lt(writeLeases.expiresAt, now) })
      .returning({ holder: writeLeases.holder });
    if (got?.holder === holder) return;
    if (Date.now() + pause > until) throw new TRPCError({ code: "TIMEOUT", message: t("server.worklogs.busy") });
    await new Promise((r) => setTimeout(r, pause));
  }
}

/** Runs `fn` holding the user's write lease: no other write of theirs, in any process, meanwhile. */
export function withWriteLease<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  if (active.getStore()?.has(userId)) return fn();
  return local(userId, async () => {
    const holder = randomUUID();
    await acquire(userId, holder);
    const beat = setInterval(() => {
      void getDb()
        .update(writeLeases)
        .set({ expiresAt: Date.now() + writeLeaseTiming.leaseMs })
        .where(and(eq(writeLeases.userId, userId), eq(writeLeases.holder, holder)))
        .returning({ holder: writeLeases.holder })
        .then((kept) => {
          // Gone: this process stalled past the lease and another one took it.
          if (kept.length === 0) console.error(`[write-lease] user ${userId}: lease lost while writing`);
        })
        .catch((e: unknown) => console.error(e));
    }, writeLeaseTiming.beatMs);
    try {
      const users = new Set(active.getStore() ?? []);
      users.add(userId);
      return await active.run(users, fn);
    } finally {
      clearInterval(beat);
      await getDb()
        .delete(writeLeases)
        .where(and(eq(writeLeases.userId, userId), eq(writeLeases.holder, holder)))
        .catch((e: unknown) => console.error(e));
    }
  });
}
