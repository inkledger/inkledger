// Copies of pinned mails (docs/work/ideas/mail-copies.md): sealed per mail, counted, deleted.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

async function makeUser(name: string) {
  const [{ id: userId }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES (?, ?, 1) RETURNING id", name, name);
  const { appRouter } = await import("../router");
  const { getDb } = await import("../queries/connection");
  const { users } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const [user] = await getDb().select().from(users).where(eq(users.id, userId));
  const caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  const { sealBytesFor } = await import("../lib/crypto");
  /** A pinned mail with a copy of `bytes` bytes. */
  const copied = async (subject: string, bytes: number) => {
    const [{ id }] = await q<{ id: number }>("INSERT INTO mails (user_id, subject, source, created_at, updated_at) VALUES (?, ?, 'eml', 1, 1) RETURNING id", userId, subject);
    const plain = Buffer.alloc(bytes, 65);
    await q(
      "INSERT INTO mail_copies (mail_id, user_id, mode, sealed, plain_sha256, plain_bytes, source, captured_at) VALUES (?, ?, 'full', ?, 'x', ?, 'eml', 1)",
      id, userId, sealBytesFor(plain, `mailcopy:${userId}:${id}`), bytes,
    );
    return id;
  };
  return { userId, caller, copied };
}

describe("mail copies", () => {
  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
  });

  it("every copy can be deleted at once", async () => {
    const a = await makeUser("c1");
    const b = await makeUser("c2");
    await a.copied("One", 1000);
    await a.copied("Two", 2500);
    const theirs = await b.copied("Theirs", 400);
    expect(await a.caller.mails.copyUsage()).toEqual({ count: 2, bytes: 3500 });
    expect(await a.caller.mails.deleteAllCopies()).toEqual({ count: 2 });
    expect(await a.caller.mails.copyUsage()).toEqual({ count: 0, bytes: 0 });
    // The mails stay pinned; only their copies go. Someone else's are untouched.
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM mails WHERE user_id = ?", a.userId))[0].n).toBe(2);
    expect(await b.caller.mails.copyUsage()).toEqual({ count: 1, bytes: 400 });
    expect((await q("SELECT 1 FROM mail_copies WHERE mail_id = ?", theirs)).length).toBe(1);
    // A mail removed takes its copy with it.
    await q("DELETE FROM mails WHERE id = ?", theirs);
    expect(await b.caller.mails.copyUsage()).toEqual({ count: 0, bytes: 0 });
  });
});
