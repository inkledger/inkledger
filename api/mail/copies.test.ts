// Copies of pinned mails (docs/work/ideas/mail-copies.md): sealed per mail, captured, counted, deleted.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jiraSignIn } from "../testing/signIn";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) }));
// Jira's /myself for the sign-ins: one account per name, so each is its own user.
vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) =>
  Response.json({ accountId: `acc-${new Headers(init?.headers).get("authorization")}`, displayName: "Mario", avatarUrls: {} }),
);

const { env: envModule } = await import("../lib/env");
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

/** A user signed in to the app (a session cookie) and to the simulated mailbox. */
async function signedIn(name: string) {
  const resHeaders = new Headers();
  await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: "https://copies.atlassian.net", deployment: "cloud", authType: "basic", username: `${name}@x.it`, secret: "t" });
  const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
  const { userFromRequest } = await import("../context");
  const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
  const { appRouter } = await import("../router");
  const caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
  const { startMailLogin, pollMailLogin } = await import("./microsoft");
  const flow = await startMailLogin(ctx.user!.id);
  expect((await pollMailLogin(ctx.user!.id, flow.flowId)).state).toBe("authorized");
  return { userId: ctx.user!.id, caller, cookie };
}

const SIM = { subject: "Release 2.3 sign-off", internetMessageId: "<sim-3@example.com>" };
const pin = (caller: Awaited<ReturnType<typeof signedIn>>["caller"]) =>
  caller.mails.pinTo({ mail: { source: "graph", subject: SIM.subject, internetMessageId: SIM.internetMessageId }, to: { todo: {} } });

async function plainOf(userId: number, mailId: number): Promise<Buffer> {
  const [row] = await q<{ sealed: Buffer }>("SELECT sealed FROM mail_copies WHERE mail_id = ?", mailId);
  const { openBytesFor } = await import("../lib/crypto");
  return openBytesFor(Buffer.from(row.sealed), `mailcopy:${userId}:${mailId}`);
}

describe("mail copies: capture", () => {
  const env = envModule;
  const saved = { sim: env.mailSimulator, max: env.mailCopyMaxMb };
  beforeAll(() => {
    env.mailSimulator = true;
  });
  afterEach(async () => {
    env.mailCopyMaxMb = saved.max;
    (await import("./simulator")).simulateContentFailure(false);
  });

  it("copies are refused while off", async () => {
    const u = await signedIn("off1");
    const { mail } = await pin(u.caller);
    // Off by default: a pin keeps no copy, and a file can't be made one.
    expect((await u.caller.mails.copyInfo({ id: mail.id })).copy).toBeNull();
    const app = (await import("../boot")).default;
    const res = await app.request(`/api/mail/${mail.id}/copy`, { method: "POST", body: "From: a@b.c\r\n\r\nhi", headers: { cookie: u.cookie, "Content-Type": "message/rfc822" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Copies of your mails are off: turn them on in Settings → Outlook." });
    expect((await q("SELECT 1 FROM mail_copies WHERE mail_id = ?", mail.id)).length).toBe(0);
  });

  it("body mode keeps no attachment content", async () => {
    const u = await signedIn("body1");
    await u.caller.settings.update({ mailCopies: "body", mailCopiesConsent: true });
    const { mail } = await pin(u.caller);
    const plain = await plainOf(u.userId, mail.id);
    const { mailCopyBodySchema } = await import("@contracts/mail");
    const body = mailCopyBodySchema.parse(JSON.parse(plain.toString("utf8")));
    expect(body.headers).toMatchObject({ subject: SIM.subject, to: ["Mario Rossi <mario.rossi@example.com>"], cc: ["Team <team@example.com>"] });
    expect(body.text).toContain("Hello Mario");
    expect(body.html).toContain("<b>Release 2.3 sign-off</b>");
    expect(body.attachments).toEqual([{ name: "notes.bin", type: "application/octet-stream", size: 1024 }]);
    const { SIM_ATTACHMENT } = await import("./simulator");
    expect(plain.includes(SIM_ATTACHMENT.subarray(0, 64))).toBe(false);
    expect(plain.includes(SIM_ATTACHMENT.toString("base64").slice(0, 64))).toBe(false);
    expect(await u.caller.mails.copyInfo({ id: mail.id })).toMatchObject({
      copy: { mode: "body", attachments: [{ index: 0, name: "notes.bin", type: "application/octet-stream", size: 1024 }] },
      copyError: null,
    });
  });

  it("full mode keeps the EML", async () => {
    const u = await signedIn("full1");
    await u.caller.settings.update({ mailCopies: "full", mailCopiesConsent: true });
    const { mail } = await pin(u.caller);
    const { simulatedEml } = await import("./simulator");
    const expected = simulatedEml({ subject: SIM.subject, from: { emailAddress: { name: "Anna Bianchi", address: "anna@example.com" } }, internetMessageId: SIM.internetMessageId, receivedDateTime: "2026-10-27T15:30:00Z" });
    expect((await plainOf(u.userId, mail.id)).equals(expected)).toBe(true);
    const info = await u.caller.mails.copyInfo({ id: mail.id });
    expect(info.copy).toMatchObject({ mode: "full", bytes: expected.length, attachments: [{ index: 0, name: "notes.bin", size: 1024 }] });
    // The same mail pinned again: the same copy, not a second one.
    await pin(u.caller);
    expect((await q("SELECT count(*)::int AS n FROM mail_copies WHERE mail_id = ?", mail.id))[0]).toEqual({ n: 1 });
  });

  it("another user's copy is not found", async () => {
    const a = await signedIn("own-a");
    const b = await signedIn("own-b");
    await a.caller.settings.update({ mailCopies: "full", mailCopiesConsent: true });
    await b.caller.settings.update({ mailCopies: "full", mailCopiesConsent: true });
    const { mail } = await pin(a.caller);
    for (const call of [() => b.caller.mails.copyInfo({ id: mail.id }), () => b.caller.mails.deleteCopy({ id: mail.id }), () => b.caller.mails.retryCopy({ id: mail.id })])
      await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
    const app = (await import("../boot")).default;
    const res = await app.request(`/api/mail/${mail.id}/copy`, { method: "POST", body: "From: x@y.z\r\n\r\nmine now", headers: { cookie: b.cookie, "Content-Type": "message/rfc822" } });
    expect(res.status).toBe(404);
    expect((await a.caller.mails.copyInfo({ id: mail.id })).copy?.mode).toBe("full");
    // Its owner can delete it; the pin stays.
    expect(await a.caller.mails.deleteCopy({ id: mail.id })).toEqual({ ok: true });
    expect((await a.caller.mails.copyInfo({ id: mail.id })).copy).toBeNull();
  });

  it("a failed copy never fails the pin", async () => {
    const u = await signedIn("fail1");
    await u.caller.settings.update({ mailCopies: "body", mailCopiesConsent: true });
    (await import("./simulator")).simulateContentFailure(true);
    const { mail } = await pin(u.caller);
    expect(mail.id).toBeGreaterThan(0);
    const failed = await u.caller.mails.copyInfo({ id: mail.id });
    expect(failed.copy).toBeNull();
    expect(failed.copyError).toBe("Outlook didn't give the mail's content: try again.");
    (await import("./simulator")).simulateContentFailure(false);
    const retried = await u.caller.mails.retryCopy({ id: mail.id });
    expect(retried).toMatchObject({ copy: { mode: "body" }, copyError: null });
  });

  it("a copy over the limit is refused", async () => {
    const u = await signedIn("big1");
    await u.caller.settings.update({ mailCopies: "full", mailCopiesConsent: true });
    const { mail } = await pin(u.caller);
    await u.caller.mails.deleteCopy({ id: mail.id });
    env.mailCopyMaxMb = 0.001; // about 1 KB
    const app = (await import("../boot")).default;
    const res = await app.request(`/api/mail/${mail.id}/copy`, { method: "POST", body: `From: a@b.c\r\nSubject: big\r\n\r\n${"x".repeat(5000)}`, headers: { cookie: u.cookie, "Content-Type": "message/rfc822" } });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "This mail is too big to keep a copy of (limit 0.001 MB)." });
    expect((await u.caller.mails.copyInfo({ id: mail.id })).copy).toBeNull();
    // Small enough: kept, from the file.
    env.mailCopyMaxMb = 30;
    const ok = await app.request(`/api/mail/${mail.id}/copy`, { method: "POST", body: "From: a@b.c\r\nSubject: small\r\n\r\nhi", headers: { cookie: u.cookie, "Content-Type": "message/rfc822" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ mode: "full" });
  });
});

