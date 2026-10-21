import { eq } from "drizzle-orm";
import { connections } from "@db/schema";
import { openSecret, sealSecret } from "../lib/crypto";
import type { Db } from "./connection";

/**
 * Every secret sealed with the current key for its own connection: older
 * ones (the session-derived format, CREDENTIALS_KEY_OLD) are sealed again,
 * at every start and after a restore. One no key opens is left as it is
 * (its connection asks to be reconnected). Returns how many were sealed again.
 */
export async function resealCredentials(db: Db): Promise<number> {
  let n = 0;
  for (const row of await db.select({ id: connections.id, encryptedSecret: connections.encryptedSecret, webhookSecret: connections.webhookSecret }).from(connections)) {
    // The webhook secret too: sealed the same way, with the same key.
    if (row.webhookSecret) {
      try {
        const hook = openSecret(row.webhookSecret, row.id);
        if (!hook.fresh) await db.update(connections).set({ webhookSecret: sealSecret(hook.plain, row.id) }).where(eq(connections.id, row.id));
      } catch {
        // unreadable: left as is, the user can turn webhooks off and on
      }
    }
    if (!row.encryptedSecret) continue;
    let opened: { plain: string; fresh: boolean };
    try {
      opened = openSecret(row.encryptedSecret, row.id);
    } catch {
      continue;
    }
    if (opened.fresh) continue;
    await db.update(connections).set({ encryptedSecret: sealSecret(opened.plain, row.id) }).where(eq(connections.id, row.id));
    n++;
  }
  return n;
}
