// Every value sealed with the credential keys, for cli.ts keys-status and
// reseal: which key opens each one, and sealing them again with the current
// key. Rows are read one at a time (mail copies can be tens of MB) and a write
// only lands when the value is still the one read (the running server may
// refresh a mailbox sign-in meanwhile).
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { connections, ideaFiles, mailAccounts, mailCopies } from "@db/schema";
import {
  keyOfBytes,
  keyOfSealed,
  keyOfSecret,
  openBytesFor,
  openFor,
  openSecret,
  sealBytesFor,
  sealFor,
  sealSecret,
  sealingKeyName,
  type KeyCheck,
  type KeyName,
} from "../lib/crypto";
import type { Db } from "./connection";

type Column<P> = {
  name: string;
  /** Row ids, in a stable order */
  ids: (db: Db) => Promise<number[]>;
  /** The sealed value, or null when the row has none (or is gone) */
  read: (db: Db, id: number) => Promise<P | null>;
  check: (payload: P, id: number) => KeyCheck;
  /** Seals it again with the current key; false when the row changed since it was read */
  reseal: (db: Db, id: number, payload: P) => Promise<boolean>;
};

const mailScope = (userId: number) => `mail:${userId}`;

const encryptedSecret: Column<string> = {
  name: "connections.encrypted_secret",
  ids: async (db) => (await db.select({ id: connections.id }).from(connections).orderBy(asc(connections.id))).map((r) => r.id),
  read: async (db, id) => (await db.select({ v: connections.encryptedSecret }).from(connections).where(eq(connections.id, id)))[0]?.v ?? null,
  check: (v, id) => keyOfSecret(v, id),
  reseal: async (db, id, v) => {
    const [row] = await db.select({ status: connections.status }).from(connections).where(eq(connections.id, id));
    // Unreadable only because no key opened it: it opens now (as at every start, queries/credentials.ts).
    const readable = row?.status === "unreadable" ? { status: "ok" as const } : {};
    const done = await db
      .update(connections)
      .set({ encryptedSecret: sealSecret(openSecret(v, id).plain, id), ...readable })
      .where(and(eq(connections.id, id), eq(connections.encryptedSecret, v)))
      .returning({ id: connections.id });
    return done.length > 0;
  },
};

const webhookSecret: Column<string> = {
  name: "connections.webhook_secret",
  ids: async (db) =>
    (await db.select({ id: connections.id }).from(connections).where(isNotNull(connections.webhookSecret)).orderBy(asc(connections.id))).map((r) => r.id),
  read: async (db, id) => (await db.select({ v: connections.webhookSecret }).from(connections).where(eq(connections.id, id)))[0]?.v ?? null,
  check: (v, id) => keyOfSecret(v, id),
  reseal: async (db, id, v) =>
    (
      await db
        .update(connections)
        .set({ webhookSecret: sealSecret(openSecret(v, id).plain, id) })
        .where(and(eq(connections.id, id), eq(connections.webhookSecret, v)))
        .returning({ id: connections.id })
    ).length > 0,
};

const mailAccountSecret: Column<string> = {
  name: "mail_accounts.secret",
  ids: async (db) => (await db.select({ id: mailAccounts.userId }).from(mailAccounts).orderBy(asc(mailAccounts.userId))).map((r) => r.id),
  read: async (db, id) => (await db.select({ v: mailAccounts.secret }).from(mailAccounts).where(eq(mailAccounts.userId, id)))[0]?.v ?? null,
  check: (v, id) => keyOfSealed(v, mailScope(id)),
  reseal: async (db, id, v) =>
    (
      await db
        .update(mailAccounts)
        .set({ secret: sealFor(openFor(v, mailScope(id)), mailScope(id)) })
        .where(and(eq(mailAccounts.userId, id), eq(mailAccounts.secret, v)))
        .returning({ id: mailAccounts.userId })
    ).length > 0,
};

/** Bytes columns: the scope needs the owner, read with the bytes. */
type Owned = { userId: number; bytes: Buffer };

const mailCopyScope = (userId: number, mailId: number) => `mailcopy:${userId}:${mailId}`;
const ideaFileScope = (userId: number, id: number) => `idea-file:${userId}:${id}`;

const mailCopySealed: Column<Owned> = {
  name: "mail_copies.sealed",
  ids: async (db) => (await db.select({ id: mailCopies.mailId }).from(mailCopies).orderBy(asc(mailCopies.mailId))).map((r) => r.id),
  read: async (db, id) => {
    const [row] = await db.select({ userId: mailCopies.userId, bytes: mailCopies.sealed }).from(mailCopies).where(eq(mailCopies.mailId, id));
    return row ? { userId: row.userId, bytes: Buffer.from(row.bytes) } : null;
  },
  check: (v, id) => keyOfBytes(v.bytes, mailCopyScope(v.userId, id)),
  reseal: async (db, id, v) => {
    const scope = mailCopyScope(v.userId, id);
    return (
      await db
        .update(mailCopies)
        .set({ sealed: sealBytesFor(openBytesFor(v.bytes, scope), scope) })
        .where(and(eq(mailCopies.mailId, id), eq(mailCopies.sealed, v.bytes)))
        .returning({ id: mailCopies.mailId })
    ).length > 0;
  },
};

const ideaFileData: Column<Owned> = {
  name: "idea_files.data",
  ids: async (db) => (await db.select({ id: ideaFiles.id }).from(ideaFiles).orderBy(asc(ideaFiles.id))).map((r) => r.id),
  read: async (db, id) => {
    const [row] = await db.select({ userId: ideaFiles.userId, bytes: ideaFiles.data }).from(ideaFiles).where(eq(ideaFiles.id, id));
    return row ? { userId: row.userId, bytes: Buffer.from(row.bytes) } : null;
  },
  check: (v, id) => keyOfBytes(v.bytes, ideaFileScope(v.userId, id)),
  reseal: async (db, id, v) => {
    const scope = ideaFileScope(v.userId, id);
    return (
      await db
        .update(ideaFiles)
        .set({ data: sealBytesFor(openBytesFor(v.bytes, scope), scope) })
        .where(and(eq(ideaFiles.id, id), eq(ideaFiles.data, v.bytes)))
        .returning({ id: ideaFiles.id })
    ).length > 0;
  },
};

/** A column with its payload type hidden: each value's key check, and a way to seal it again. */
type Sealed = {
  name: string;
  each: (db: Db, visit: (id: number, check: KeyCheck, reseal: () => Promise<boolean>) => Promise<void> | void) => Promise<void>;
};

const erased = <P>(col: Column<P>): Sealed => ({
  name: col.name,
  each: async (db, visit) => {
    for (const id of await col.ids(db)) {
      const payload = await col.read(db, id);
      if (payload !== null) await visit(id, col.check(payload, id), () => col.reseal(db, id, payload));
    }
  },
});

/** Every sealed column (a new one is added here, or keys-status and reseal miss it). */
const COLUMNS: readonly Sealed[] = [erased(encryptedSecret), erased(webhookSecret), erased(mailAccountSecret), erased(mailCopySealed), erased(ideaFileData)];

export type ColumnKeys = { column: string; total: number; unreadable: number } & Record<KeyName, number>;

export type KeysStatus = { sealingKey: KeyName; columns: ColumnKeys[]; warnings: string[] };

/** Per sealed column, how many values each key opens and how many none does; with what to fix first. */
export async function keysStatus(db: Db): Promise<KeysStatus> {
  const columns: ColumnKeys[] = [];
  for (const col of COLUMNS) {
    const c: ColumnKeys = { column: col.name, total: 0, unreadable: 0, CREDENTIALS_KEY: 0, CREDENTIALS_KEY_OLD: 0, SESSION_SECRET: 0 };
    await col.each(db, (_id, check) => {
      c.total++;
      if (check) c[check.key]++;
      else c.unreadable++;
    });
    columns.push(c);
  }
  const sum = (k: keyof Omit<ColumnKeys, "column">) => columns.reduce((n, c) => n + c[k], 0);
  const sealingKey = sealingKeyName();
  const warnings: string[] = [];
  if (sealingKey === "SESSION_SECRET") {
    warnings.push(
      "CREDENTIALS_KEY is not set: every sealed value and every share link depends on SESSION_SECRET. Set CREDENTIALS_KEY, restart, run reseal --apply, and only then change SESSION_SECRET.",
    );
  } else if (sum("SESSION_SECRET") > 0) {
    warnings.push(`${sum("SESSION_SECRET")} value(s) still open only with the key derived from SESSION_SECRET: run reseal --apply before changing SESSION_SECRET.`);
  }
  if (sum("CREDENTIALS_KEY_OLD") > 0) warnings.push(`${sum("CREDENTIALS_KEY_OLD")} value(s) still need CREDENTIALS_KEY_OLD: run reseal --apply before removing it.`);
  if (sum("unreadable") > 0) warnings.push(`${sum("unreadable")} value(s) open with no configured key: reseal lists them; they need the key they were sealed with, or a reconnect.`);
  return { sealingKey, columns, warnings };
}

export type ColumnReseal = { column: string; current: number; resealed: number; changed: number; unreadable: number[] };

export type ResealReport = { applied: boolean; sealingKey: KeyName; columns: ColumnReseal[] };

/**
 * Every value that opens but isn't sealed with the current key yet is sealed
 * again with it (counted only, unless `apply`); values no key opens are listed
 * by row id, left as they are. `changed`: rows written meanwhile by the server, skipped.
 */
export async function resealAll(db: Db, { apply }: { apply: boolean }): Promise<ResealReport> {
  const columns: ColumnReseal[] = [];
  for (const col of COLUMNS) {
    const c: ColumnReseal = { column: col.name, current: 0, resealed: 0, changed: 0, unreadable: [] };
    await col.each(db, async (id, check, reseal) => {
      if (!check) c.unreadable.push(id);
      else if (check.fresh) c.current++;
      else if (!apply) c.resealed++;
      else if (await reseal()) c.resealed++;
      else c.changed++;
    });
    columns.push(c);
  }
  return { applied: apply, sealingKey: sealingKeyName(), columns };
}
