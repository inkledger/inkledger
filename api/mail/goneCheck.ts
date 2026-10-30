// Mails deleted in Outlook (docs/work/ideas/mail-copies.md R-1.11): once a day, for each user
// signed in to their mailbox, up to 200 pinned mails are looked for, the longest unchecked
// first. Not found: gone (the card says so, its copy stands in); found again: not gone.
// Throttled (429) or Graph busy (503): that user's pass stops, the next one goes on.
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { mailAccounts, mails } from "@db/schema";
import { getDb } from "../queries/connection";
import { isShuttingDown } from "../lib/shutdown";
import { findByMessageId } from "./microsoft";

const PER_PASS = 200;
const DAY_MS = 86_400_000;
/** The first pass a while after start, not with the boot's other work. */
const FIRST_PASS_DELAY_MS = 15 * 60_000;

/** One mail looked for now: its gone mark set or cleared. Throws on Graph's refusals. */
export async function checkMail(userId: number, mail: { id: number; internetMessageId: string; goneAt: Date | null }, now: number): Promise<Date | null> {
  const found = await findByMessageId(userId, mail.internetMessageId);
  const goneAt = found ? null : (mail.goneAt ?? new Date(now));
  await getDb().update(mails).set({ goneAt, checkedAt: new Date(now) }).where(eq(mails.id, mail.id));
  return goneAt;
}

/** One pass over every user signed in to a mailbox. */
export async function checkGonePass(now = Date.now()): Promise<void> {
  const users = await getDb().select({ userId: mailAccounts.userId }).from(mailAccounts);
  for (const { userId } of users) {
    if (isShuttingDown()) return;
    const due = await getDb()
      .select({ id: mails.id, internetMessageId: mails.internetMessageId, goneAt: mails.goneAt })
      .from(mails)
      .where(and(eq(mails.userId, userId), isNotNull(mails.internetMessageId)))
      .orderBy(sql`${mails.checkedAt} ASC NULLS FIRST`, asc(mails.id))
      .limit(PER_PASS);
    for (const m of due) {
      try {
        await checkMail(userId, { id: m.id, internetMessageId: m.internetMessageId!, goneAt: m.goneAt }, now);
      } catch {
        // Throttled or busy (429, 503), signed out, a network blip: this user waits for the next pass.
        break;
      }
    }
  }
}

/** The daily pass, timed from the end of the last one (R-0.4); stop() waits for a pass under way. */
export function startGoneCheck(): () => Promise<void> {
  let stopped = false;
  let current: Promise<unknown> | null = null;
  let handle: ReturnType<typeof setTimeout>;
  const schedule = (ms: number) => {
    handle = setTimeout(() => {
      current = checkGonePass()
        .catch(() => undefined)
        .finally(() => {
          current = null;
          if (!stopped) schedule(DAY_MS);
        });
    }, ms);
    handle.unref();
  };
  schedule(FIRST_PASS_DELAY_MS);
  return async () => {
    stopped = true;
    clearTimeout(handle);
    await current;
  };
}
