// Mails deleted in Outlook (docs/work/ideas/mail-copies.md R-1.11): once a day, for each user
// signed in to their mailbox, up to 200 pinned mails are looked for, the longest unchecked
// first. Not found: gone (the card says so, its copy stands in); found again: not gone. Only
// mails found in that mailbox once (kept on the mail) can be gone: another mailbox's never.
// Throttled (429) or Graph busy (503): that user's pass stops, the next one goes on.
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { mailAccounts, mails } from "@db/schema";
import { getDb } from "../queries/connection";
import { isShuttingDown } from "../lib/shutdown";
import { DAY_MS } from "@contracts/time";
import { findByMessageId } from "./microsoft";
import { ProviderError } from "../providers/core/errors";

const PER_PASS = 200;
/** The first pass a while after start, not with the boot's other work. */
const FIRST_PASS_DELAY_MS = 15 * 60_000;

/**
 * One mail looked for now in the signed-in mailbox (`account`): its gone mark set or cleared.
 * Only one known to be in that mailbox is called gone: another mailbox's (shared, a second
 * account) is never looked for, one not known to be anywhere (a file) only kept when found.
 * Throws on Graph's refusals.
 */
export async function checkMail(
  userId: number,
  account: string,
  mail: { id: number; internetMessageId: string; goneAt: Date | null; mailbox: string | null },
  now: number,
): Promise<{ found: boolean; goneAt: Date | null }> {
  const box = account.toLowerCase();
  if (mail.mailbox !== null && mail.mailbox !== box) return { found: false, goneAt: mail.goneAt };
  const found = await findByMessageId(userId, mail.internetMessageId);
  const goneAt = found ? null : mail.mailbox === null ? mail.goneAt : (mail.goneAt ?? new Date(now));
  await getDb()
    .update(mails)
    .set({ goneAt, checkedAt: new Date(now), ...(found ? { mailbox: box } : {}) })
    .where(eq(mails.id, mail.id));
  return { found: !!found, goneAt };
}

/** One pass over every user signed in to a mailbox. */
export async function checkGonePass(now = Date.now()): Promise<void> {
  const users = await getDb().select({ userId: mailAccounts.userId, account: mailAccounts.account }).from(mailAccounts);
  for (const { userId, account } of users) {
    if (isShuttingDown()) return;
    const due = await getDb()
      .select({ id: mails.id, internetMessageId: mails.internetMessageId, goneAt: mails.goneAt, mailbox: mails.mailbox })
      .from(mails)
      // Another mailbox's are not looked for here.
      .where(and(eq(mails.userId, userId), isNotNull(mails.internetMessageId), or(isNull(mails.mailbox), eq(mails.mailbox, account.toLowerCase()))))
      .orderBy(sql`${mails.checkedAt} ASC NULLS FIRST`, asc(mails.id))
      .limit(PER_PASS);
    for (const m of due) {
      try {
        await checkMail(userId, account, { id: m.id, internetMessageId: m.internetMessageId!, goneAt: m.goneAt, mailbox: m.mailbox }, now);
      } catch (e) {
        // One mail Graph refuses (an id it can't read): looked for again on a later pass, the others now.
        if (e instanceof ProviderError && e.kind === "invalid") {
          await getDb().update(mails).set({ checkedAt: new Date(now) }).where(eq(mails.id, m.id));
          continue;
        }
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
