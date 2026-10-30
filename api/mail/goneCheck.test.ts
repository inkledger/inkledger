// Mails deleted in Outlook (docs/work/ideas/mail-copies.md R-1.11): looked for once a day, at most 200 per user, oldest check first.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) }));

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
const { env } = await import("../lib/env");
const sim = await import("./simulator");

/** A user signed in to the simulated mailbox. */
async function signedIn(name: string) {
  const [{ id: userId }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES (?, ?, 1) RETURNING id", name, name);
  const { startMailLogin, pollMailLogin } = await import("./microsoft");
  const flow = await startMailLogin(userId);
  expect((await pollMailLogin(userId, flow.flowId)).state).toBe("authorized");
  return userId;
}

const mail = async (userId: number, messageId: string, checkedAt: number | null = null) =>
  (
    await q<{ id: number }>(
      "INSERT INTO mails (user_id, subject, internet_message_id, source, checked_at, created_at, updated_at) VALUES (?, ?, ?, 'graph', ?, 1, 1) RETURNING id",
      userId, messageId, messageId, checkedAt,
    )
  )[0].id;

describe("gone check", () => {
  beforeAll(async () => {
    env.mailSimulator = true;
    await (await import("../queries/connection")).resetDbForTests();
  });
  afterEach(() => {
    sim.simulateForget(null);
    sim.simulateThrottle(null);
  });

  it("a deleted mail is noticed and a restored one cleared", async () => {
    const userId = await signedIn("gone1");
    const id = await mail(userId, "sim-3@example.com");
    const { checkGonePass } = await import("./goneCheck");
    await checkGonePass(Date.now());
    expect((await q<{ gone_at: number | null; checked_at: number | null }>("SELECT gone_at, checked_at FROM mails WHERE id = ?", id))[0]).toMatchObject({ gone_at: null });
    // Deleted in Outlook: the next pass says so.
    sim.simulateForget("<sim-3@example.com>");
    const at = Date.now();
    await checkGonePass(at);
    expect(Number((await q<{ gone_at: number }>("SELECT gone_at FROM mails WHERE id = ?", id))[0].gone_at)).toBe(at);
    // Back (restored from Deleted Items): cleared.
    sim.simulateForget(null);
    await checkGonePass(Date.now());
    expect((await q("SELECT gone_at FROM mails WHERE id = ?", id))[0]).toEqual({ gone_at: null });
  });

  it("a pass checks at most 200, oldest first, and stops on throttling", async () => {
    const userId = await signedIn("gone2");
    // Only this user signed in: the calls counted below are all theirs.
    await q("DELETE FROM mail_accounts WHERE user_id <> ?", userId);
    // 250 mails, checked long ago in order (none in the mailbox: all found gone).
    const ids: number[] = [];
    for (let n = 0; n < 250; n++) ids.push(await mail(userId, `old-${n}@example.com`, 1000 + n));
    const { checkGonePass } = await import("./goneCheck");
    const now = Date.now();
    await checkGonePass(now);
    const checked = await q<{ id: number }>("SELECT id FROM mails WHERE user_id = ? AND checked_at = ? ORDER BY id", userId, now);
    expect(checked.map((r) => r.id)).toEqual(ids.slice(0, 200));
    // Throttled after 10 calls: the pass stops for this user; the rest waits for the next one.
    sim.simulateThrottle(10);
    const later = now + 1;
    await checkGonePass(later);
    const second = await q<{ id: number }>("SELECT id FROM mails WHERE user_id = ? AND checked_at = ? ORDER BY id", userId, later);
    expect(second.map((r) => r.id)).toEqual(ids.slice(200, 210));
  });
});
