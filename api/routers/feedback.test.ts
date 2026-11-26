import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = ":memory:";
process.env.FEEDBACK_URL = "https://inbox.test";
process.env.INSTANCE_KEY_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ikl-feedback-")), "instance.key");

import type { Permission } from "@contracts/accounts";

/**
 * Feedback (Info > Feedback): everyone's own, readFeedback reads all, manageFeedback moves
 * them through their states; sharing with inkledger's developers is off until turned on,
 * needs the author's consent per feedback, leaves anonymised and signed, and the
 * developers' state comes back without undoing what an admin here decided since.
 */

type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
const q = async <T = Record<string, unknown>>(text: string, ...params: unknown[]): Promise<T[]> => (await import("../queries/connection")).q<T>(text, ...params);

async function as(id: number): Promise<Caller> {
  const { userById } = await import("../queries/accounts");
  const { appRouter } = await import("../router");
  return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: (await userById(id)) ?? null, sessionId: null });
}

let n = 0;
async function member(permissions: Permission[] = []): Promise<number> {
  n++;
  const [row] = await q<{ id: number }>(
    "INSERT INTO users (username, display_name, role, permissions, email, created_at) VALUES (?, ?, 'member', ?, ?, 1) RETURNING id",
    `person${n}`,
    `Person Number${n}`,
    JSON.stringify(permissions),
    `person${n}@example.com`,
  );
  return row.id;
}

async function events(action: string) {
  const { flushAudit } = await import("../lib/audit");
  await flushAudit();
  return q<{ actor_user_id: number | null; target_id: string | null; after: string | null; outcome: string }>("SELECT actor_user_id, target_id, after, outcome FROM audit_events WHERE action = ? ORDER BY id", action);
}

/** What reached the inbox (FEEDBACK_URL), and what it answers next. */
type Call = { url: string; method: string; headers: Record<string, string>; body: string };
/** Every item of a batch taken, as the inbox answers it. */
const takeAll = (c: Call) => json({ results: (JSON.parse(c.body) as { items: { id: string }[] }).items.map(i => ({ id: i.id, ok: true })) });
const store = { calls: [] as Call[], post: takeAll, status: ((): Response => json({ cursor: 0, items: [] })) as (c: Call) => Response };
const posts = () => store.calls.filter(c => c.method === "POST");
const gets = () => store.calls.filter(c => c.method === "GET");
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
/** The signature the inbox checks (inkledger/feedback src/signature.ts), checked the same way here. */
function signedByInstance(c: Call): boolean {
  const raw = Buffer.from(c.headers["x-ikl-pubkey"], "base64url");
  const id = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  if (id !== c.headers["x-ikl-instance"]) return false;
  const u = new URL(c.url);
  const message = `inkledger-feedback-v1\n${c.method}\n${u.pathname}${u.search}\n${c.headers["x-ikl-time"]}\n${id}\n${createHash("sha256").update(c.body).digest("hex")}`;
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
  return verify(null, Buffer.from(message), key, Buffer.from(c.headers["x-ikl-sig"], "base64url"));
}

const base = { type: "problem" as const, title: "The board flickers", body: "It flickers on ABC-12 when I drag.", page: "/issues/ABC-12?q=assignee:me", look: "dark·soft·normal", density: "compact" as const };

describe("feedback", () => {
  let ann: number;
  let bob: number;
  let reader: number;
  let manager: number;

  beforeAll(async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      store.calls.push({ url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : "" });
      const call = store.calls.at(-1)!;
      if (url.startsWith("https://inbox.test/feedback/status")) return store.status(call);
      if (url === "https://inbox.test/feedback") return store.post(call);
      return json({ error: "unexpected" }, 500);
    });
    await (await import("../queries/connection")).resetDbForTests();
    ann = await member();
    bob = await member();
    reader = await member(["readFeedback"]);
    manager = await member(["manageFeedback"]);
  });

  beforeEach(async () => {
    store.calls.length = 0;
    store.post = takeAll;
    store.status = () => json({ cursor: 0, items: [] });
    const { setSharing, forgetStatusSync } = await import("../feedback/upstream");
    await setSharing(false);
    await forgetStatusSync();
    const { setServerSetting } = await import("../lib/serverSettings");
    await setServerSetting("feedback.pausedUntil", 0);
    // Each test its own queue.
    await q("UPDATE feedback SET share_state = NULL WHERE share_state = 'queued'");
  });

  it("is its author's own: someone else reads it as missing; readFeedback reads all, manageFeedback answers", async () => {
    const { id } = await (await as(ann)).feedback.create(base);
    const mine = await (await as(ann)).feedback.mine();
    expect(mine.map(f => f.id)).toContain(id);
    expect(mine[0]).not.toHaveProperty("screenshot");
    // The server records its build, never the page's word for it.
    expect((await (await as(ann)).feedback.get({ id })).appVersion).toBe("dev");

    const b = await as(bob);
    expect((await b.feedback.mine()).map(f => f.id)).not.toContain(id);
    await expect(b.feedback.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.feedback.comment({ id, body: "hi" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(b.feedback.all()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(b.feedback.setStatus({ id, status: "accepted" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(b.feedback.export({ scope: "all", format: "json" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const r = await as(reader);
    expect((await r.feedback.all()).map(f => f.id)).toContain(id);
    expect((await r.feedback.all({ userId: ann })).every(f => f.userId === ann)).toBe(true);
    expect((await r.feedback.get({ id })).canManage).toBe(false);
    await expect(r.feedback.comment({ id, body: "hi" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(r.feedback.setStatus({ id, status: "accepted" })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const m = await as(manager);
    expect((await m.feedback.get({ id })).canManage).toBe(true);
    await m.feedback.comment({ id, body: "Which browser?" });
    await (await as(ann)).feedback.comment({ id, body: "Firefox" });
    const thread = (await (await as(ann)).feedback.get({ id })).thread;
    expect(thread.map(c => [c.origin, c.body])).toEqual([
      ["admin", "Which browser?"],
      ["user", "Firefox"],
    ]);
    expect((await events("feedback.create")).at(-1)).toMatchObject({ actor_user_id: ann, target_id: String(id), outcome: "ok" });
    expect((await events("feedback.comment")).length).toBeGreaterThanOrEqual(2);
  });

  it("moves through its states; a rejection says why; its author is told, never the one who moved it", async () => {
    const { id } = await (await as(ann)).feedback.create({ ...base, title: "Lifecycle" });
    const m = await as(manager);
    for (const status of ["discussion", "accepted", "in_progress", "implemented"] as const) {
      expect(await m.feedback.setStatus({ id, status })).toEqual({ changed: true });
    }
    expect(await m.feedback.setStatus({ id, status: "implemented" })).toEqual({ changed: false });
    await expect(m.feedback.setStatus({ id, status: "rejected" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await m.feedback.setStatus({ id, status: "rejected", reason: "Out of scope" });
    const f = await (await as(ann)).feedback.get({ id });
    expect(f.status).toBe("rejected");
    expect(f.statusReason).toBe("Out of scope");
    expect(f.thread.filter(c => c.origin === "status").map(c => c.statusTo)).toEqual(["discussion", "accepted", "in_progress", "implemented", "rejected"]);

    const told = (await (await as(ann)).notifications.alerts()).filter(a => a.alert === "feedback" && a.ref === id);
    expect(told.length).toBe(5);
    expect(told.every(a => a.name === "Lifecycle" && a.what === "status")).toBe(true);
    expect((await (await as(manager)).notifications.alerts()).some(a => a.alert === "feedback")).toBe(false);
    const audited = (await events("feedback.setStatus")).filter(e => e.target_id === String(id));
    expect(audited.at(-1)).toMatchObject({ actor_user_id: manager, outcome: "ok" });
    expect(JSON.parse(audited.at(-1)!.after ?? "{}")).toEqual({ from: "implemented", to: "rejected" });
  });

  it("is never sent without sharing on and its author's consent", async () => {
    const a = await as(ann);
    await expect(a.feedback.create({ ...base, share: true })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((await a.feedback.access()).sharing).toBe(false);
    await expect(a.feedback.setSharing({ enabled: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await (await as(manager)).feedback.setSharing({ enabled: true });
    expect((await a.feedback.access()).sharing).toBe(true);

    const { id } = await a.feedback.create({ ...base, title: "Not shared" });
    const { forwardQueued } = await import("../feedback/upstream");
    await forwardQueued();
    expect(store.calls).toEqual([]);
    expect((await a.feedback.get({ id })).shareState).toBeNull();

    // A row queued without its author's consent (whatever queued it) never leaves.
    await q("UPDATE feedback SET share_state = 'queued' WHERE id = ?", id);
    await forwardQueued();
    expect(store.calls).toEqual([]);
    expect((await a.feedback.get({ id })).shareState).toBeNull();
  });

  it("leaves in one signed, anonymised batch per cycle, never at creation, and once", async () => {
    await (await as(manager)).feedback.setSharing({ enabled: true });
    const a = await as(ann);
    const { id } = await a.feedback.create({ ...base, share: true });
    await (await as(bob)).feedback.create({ ...base, title: "Bob's shared one", share: true });
    await a.feedback.create({ ...base, title: "Third", share: true });
    // Created: queued, nothing sent yet.
    expect(store.calls).toEqual([]);
    expect((await a.feedback.get({ id })).shareState).toBe("queued");

    const { forwardQueued, userPseudonym } = await import("../feedback/upstream");
    expect(await forwardQueued()).toEqual({ sent: 3, refused: 0, failed: 0 });
    expect(posts()).toHaveLength(1);
    expect(signedByInstance(posts()[0])).toBe(true);
    // A signature for another body is no signature.
    expect(signedByInstance({ ...posts()[0], body: posts()[0].body.replace("flickers", "flicker") })).toBe(false);

    const sent = JSON.parse(posts()[0].body) as { v: number; items: Record<string, unknown>[] };
    expect(sent.v).toBe(2);
    expect(sent.items).toHaveLength(3);
    expect(sent.items[0]).toMatchObject({ type: "problem", title: base.title, body: base.body, route: "/issues/:id", look: base.look, density: "compact" });
    expect(sent.items[0]).not.toHaveProperty("screenshot");
    for (const personal of ["person", "Person Number", "@example.com", "assignee", "ABC-12?q"]) expect(posts()[0].body).not.toContain(personal);
    expect(String(sent.items[0].user)).toMatch(/^[0-9a-f]{32}$/);
    expect(await userPseudonym(ann)).toBe(sent.items[0].user);
    expect(sent.items[1].user).toBe(await userPseudonym(bob));
    expect(sent.items[1].user).not.toBe(sent.items[0].user);
    const [row] = await q<{ uid: string }>("SELECT uid FROM feedback WHERE id = ?", id);
    expect(sent.items[0].id).toBe(row.uid);
    expect((await a.feedback.get({ id })).shareState).toBe("sent");

    // Sent once: the next cycle has nothing queued.
    await forwardQueued();
    expect(posts()).toHaveLength(1);
  });

  it("keeps its queue when the inbox asks to wait, and never asks before then", async () => {
    await (await as(manager)).feedback.setSharing({ enabled: true });
    const a = await as(ann);
    const { forwardQueued, pausedUntil } = await import("../feedback/upstream");
    const { id } = await a.feedback.create({ ...base, title: "Later", share: true });
    const now = Date.now();
    store.post = () => new Response(JSON.stringify({ error: "rate", retryAfter: 3600 }), { status: 429, headers: { "retry-after": "3600", "content-type": "application/json" } });
    expect(await forwardQueued({ now })).toEqual({ sent: 0, refused: 0, failed: 1 });
    expect((await a.feedback.get({ id })).shareState).toBe("queued");
    expect(await pausedUntil()).toBe(now + 3_600_000);
    store.post = takeAll;
    await forwardQueued({ now: now + 60_000 });
    expect(posts()).toHaveLength(1);
    await forwardQueued({ now: now + 2 * 3_600_000 });
    expect(posts()).toHaveLength(2);
    expect((await a.feedback.get({ id })).shareState).toBe("sent");
  });

  it("stays queued while the inbox can't take it, and stops for good when it refuses an item", async () => {
    await (await as(manager)).feedback.setSharing({ enabled: true });
    const a = await as(ann);
    const { forwardQueued } = await import("../feedback/upstream");
    const { id } = await a.feedback.create({ ...base, title: "Unpublished inbox", share: true });
    // Not published yet (404 without its own answer), or down: tried again later.
    store.post = () => new Response("Not Found", { status: 404 });
    await forwardQueued();
    expect((await a.feedback.get({ id })).shareState).toBe("queued");
    store.post = () => json({ error: "retry" }, 503);
    await forwardQueued();
    expect((await a.feedback.get({ id })).shareState).toBe("queued");
    // The inbox refuses this one item: never again.
    store.post = c => json({ results: (JSON.parse(c.body) as { items: { id: string }[] }).items.map(i => ({ id: i.id, error: "input" })) });
    await forwardQueued();
    expect((await a.feedback.get({ id })).shareState).toBe("refused");
    // Turned off: nothing more leaves, even what is queued.
    await q("UPDATE feedback SET share_state = 'queued' WHERE id = ?", id);
    await (await as(manager)).feedback.setSharing({ enabled: false });
    store.calls.length = 0;
    await forwardQueued();
    expect(store.calls).toEqual([]);
  });

  it("reads states back at most daily, only while something shared is open, with a cursor and an ETag", async () => {
    await (await as(manager)).feedback.setSharing({ enabled: true });
    const a = await as(ann);
    const { syncStatuses, forwardQueued } = await import("../feedback/upstream");
    // Nothing shared open: no call at all.
    await q("UPDATE feedback SET upstream_status = 'implemented' WHERE share_state = 'sent'");
    await syncStatuses();
    expect(gets()).toHaveLength(0);

    const { id } = await a.feedback.create({ ...base, title: "Synced", share: true });
    await forwardQueued();
    const [{ uid }] = await q<{ uid: string }>("SELECT uid FROM feedback WHERE id = ?", id);
    let doc = { cursor: 1000, etag: '"1000"', items: [{ id: uid, status: "accepted", replies: [{ id: "c1", body: "Thanks, we'll look at it.", at: 1_700_000_000_000 }] }, { id: "someone-else", status: "rejected", replies: [] }] };
    store.status = c => (c.headers["if-none-match"] === doc.etag ? new Response(null, { status: 304, headers: { etag: doc.etag } }) : new Response(JSON.stringify({ cursor: doc.cursor, items: doc.items }), { headers: { etag: doc.etag, "content-type": "application/json" } }));

    const day0 = Date.now();
    await syncStatuses(day0);
    expect(gets()).toHaveLength(1);
    expect(new URL(gets()[0].url).searchParams.get("since")).toBe("0");
    expect(gets()[0].headers["if-none-match"]).toBeUndefined();
    expect(signedByInstance(gets()[0])).toBe(true);
    let f = await a.feedback.get({ id });
    expect(f.status).toBe("accepted");
    expect(f.thread.filter(c => c.origin === "upstream" && !c.statusTo).map(c => c.body)).toEqual(["Thanks, we'll look at it."]);
    expect(f.thread.filter(c => c.origin === "upstream" && c.statusTo).map(c => [c.statusFrom, c.statusTo])).toEqual([["new", "accepted"]]);

    // The same day: not asked again.
    await syncStatuses(day0 + 3_600_000);
    expect(gets()).toHaveLength(1);

    // The next day, nothing new: the cursor and ETag sent, a 304, nothing changes.
    await syncStatuses(day0 + 25 * 3_600_000);
    expect(gets()).toHaveLength(2);
    expect(new URL(gets()[1].url).searchParams.get("since")).toBe("1000");
    expect(gets()[1].headers["if-none-match"]).toBe('"1000"');
    f = await a.feedback.get({ id });
    expect(f.thread.filter(c => c.origin === "upstream")).toHaveLength(2);

    // An admin here moves it; the developers' unchanged state doesn't move it back.
    await (await as(manager)).feedback.setStatus({ id, status: "in_progress" });
    doc = { ...doc, cursor: 2000, etag: '"2000"', items: [{ ...doc.items[0] }] };
    await syncStatuses(day0 + 50 * 3_600_000);
    expect((await a.feedback.get({ id })).status).toBe("in_progress");

    // The developers move it: news, applied; closed, nothing more is asked for it.
    doc = { cursor: 3000, etag: '"3000"', items: [{ ...doc.items[0], status: "implemented" }] };
    await syncStatuses(day0 + 75 * 3_600_000);
    expect((await a.feedback.get({ id })).status).toBe("implemented");
    const told = (await a.notifications.alerts()).filter(n => n.alert === "feedback" && n.ref === id);
    expect(told.some(n => n.what === "comment")).toBe(true);
    expect(told.filter(n => n.what === "status").length).toBeGreaterThanOrEqual(3);
    const before = gets().length;
    await syncStatuses(day0 + 100 * 3_600_000);
    expect(gets()).toHaveLength(before);
  });

  it("made public: links kept (GitHub pages only), a merged proposal reads as implemented, the author told", async () => {
    await (await as(manager)).feedback.setSharing({ enabled: true });
    const a = await as(ann);
    const { syncStatuses, forwardQueued, readStatusAnswer } = await import("../feedback/upstream");
    const { id } = await a.feedback.create({ ...base, title: "Made public", share: true });
    await forwardQueued();
    const [{ uid }] = await q<{ uid: string }>("SELECT uid FROM feedback WHERE id = ?", id);
    const issueUrl = "https://github.com/inkledger/inkledger/issues/123";
    const prUrl = "https://github.com/inkledger/inkledger/pull/124";
    let items: Record<string, unknown>[] = [{ id: uid, status: "accepted", replies: [], publicIssueUrl: issueUrl, publicIssueState: "open", publicPrUrl: prUrl, publicPrState: "open" }];
    let cursor = 10;
    store.status = () => json({ cursor, items });

    const day0 = Date.now();
    await syncStatuses(day0);
    let f = await a.feedback.get({ id });
    expect(f.status).toBe("accepted");
    expect([f.publicIssueUrl, f.publicIssueState, f.publicPrUrl, f.publicPrState]).toEqual([issueUrl, "open", prUrl, "open"]);
    expect((await a.feedback.mine()).find(m => m.id === id)?.publicIssueUrl).toBe(issueUrl);
    const told = async () => (await a.notifications.alerts()).filter(n => n.alert === "feedback" && n.ref === id && n.what === "status").length;
    // One alert: the change of state and the links came together.
    expect(await told()).toBe(1);

    // The proposal merged (labels still "accepted"): implemented here.
    items = [{ ...items[0], publicIssueState: "closed", publicPrState: "merged" }];
    cursor = 20;
    await syncStatuses(day0 + 25 * 3_600_000);
    f = await a.feedback.get({ id });
    expect(f.status).toBe("implemented");
    expect([f.publicIssueState, f.publicPrState]).toEqual(["closed", "merged"]);
    expect(f.thread.filter(c => c.origin === "upstream" && c.statusTo).map(c => c.statusTo)).toEqual(["accepted", "implemented"]);

    // Anything but a GitHub issue / pull page is dropped (FEEDBACK_URL may be anyone's Worker).
    const read = (extra: Record<string, unknown>) => readStatusAnswer({ cursor: 1, items: [{ id: uid, status: "accepted", replies: [], ...extra }] }).items[0]?.pub;
    expect(read({ publicIssueUrl: "javascript:alert(1)" })).toBeUndefined();
    expect(read({ publicIssueUrl: "https://evil.example/inkledger/inkledger/issues/1" })).toBeUndefined();
    expect(read({ publicIssueUrl: issueUrl, publicPrUrl: "https://github.com/a/b/issues/2", publicPrState: "merged" })).toEqual({ issueUrl, issueState: "open", prUrl: null, prState: null });
    expect(read({ publicIssueUrl: issueUrl, publicIssueState: "weird", publicPrUrl: prUrl, publicPrState: "weird" })).toEqual({ issueUrl, issueState: "open", prUrl, prState: "open" });
  });

  it("signs exactly as the shared protocol vectors say", async () => {
    const vectors = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../feedback/__fixtures__/signature-vectors.json"), "utf8")) as {
      instanceId: string;
      pubkey: string;
      vectors: { method: string; path: string; time: string; body: string; message: string; sig: string; valid: boolean }[];
    };
    const { signedMessage } = await import("../feedback/upstream");
    const raw = Buffer.from(vectors.pubkey, "base64url");
    expect(createHash("sha256").update(raw).digest("hex").slice(0, 32)).toBe(vectors.instanceId);
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: "der", type: "spki" });
    for (const v of vectors.vectors) {
      const message = signedMessage(v.method, v.path, v.time, vectors.instanceId, v.body);
      if (v.valid) expect(message).toBe(v.message);
      expect(verify(null, Buffer.from(message), key, Buffer.from(v.sig, "base64url"))).toBe(v.valid);
    }
  });

  it("exports what the reader may see, as Markdown or JSON, and says so in the log", async () => {
    const a = await as(ann);
    await a.feedback.create({ ...base, title: "Export me" });
    await (await as(bob)).feedback.create({ ...base, title: "Bob's own" });
    const md = await a.feedback.export({ scope: "mine", format: "markdown" });
    expect(md.name).toMatch(/^inkledger-feedback-\d{4}-\d{2}-\d{2}\.md$/);
    expect(md.content).toContain("Export me");
    expect(md.content).not.toContain("Bob's own");
    const js = JSON.parse((await (await as(reader)).feedback.export({ scope: "all", format: "json", filter: { userId: bob } })).content) as { items: { title: string }[] };
    expect(js.items.map(i => i.title)).toContain("Bob's own");
    expect(js.items.map(i => i.title)).not.toContain("Export me");
    const logged = await events("feedback.export");
    expect(logged.map(e => JSON.parse(e.after ?? "{}") as { scope: string })).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "mine" }), expect.objectContaining({ scope: "all" })]));
  });

  describe("screenshots", () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);
    async function cookieOf(id: number): Promise<string> {
      const token = randomBytes(32).toString("base64url");
      await q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", createHash("sha256").update(token).digest("hex"), id, Date.now() + 3_600_000, Date.now());
      const { sessionCookie } = await import("../lib/session");
      return sessionCookie(new Request("http://localhost/"), token, 3600).split(";")[0];
    }
    const app = async () => (await import("../boot")).default;
    const upload = async (id: number, cookie: string, bytes: Uint8Array<ArrayBuffer>, type = "image/png") => {
      const form = new FormData();
      form.append("file", new File([bytes], "shot", { type }));
      return (await app()).request(`/api/feedback/${id}/screenshot`, { method: "POST", body: form, headers: { cookie } });
    };
    const fetchShot = async (id: number, cookie: string) => (await app()).request(`/api/feedback/${id}/screenshot`, { headers: { cookie } });

    it("is its author's to add once, read by whoever may read the feedback, an image only", async () => {
      const a = await as(ann);
      const [annC, bobC, readerC] = [await cookieOf(ann), await cookieOf(bob), await cookieOf(reader)];
      const { id } = await a.feedback.create({ ...base, title: "With a picture", screenshot: true });
      expect((await upload(id, bobC, PNG)).status).toBe(404);
      expect((await upload(id, annC, new Uint8Array(Buffer.from("<svg/>")), "image/svg+xml")).status).toBe(415);
      expect((await upload(id, annC, PNG)).status).toBe(200);
      expect((await upload(id, annC, PNG)).status).toBe(409);
      expect((await a.feedback.get({ id })).hasScreenshot).toBe(true);
      // Sealed at rest, never the bytes as sent.
      const [row] = await q<{ screenshot: Buffer }>("SELECT screenshot FROM feedback WHERE id = ?", id);
      expect(Buffer.from(row.screenshot).includes(Buffer.from(PNG))).toBe(false);

      expect((await fetchShot(id, bobC)).status).toBe(404);
      for (const cookie of [annC, readerC]) {
        const got = await fetchShot(id, cookie);
        expect(got.status).toBe(200);
        expect(got.headers.get("content-type")).toBe("image/png");
        expect(got.headers.get("x-content-type-options")).toBe("nosniff");
        expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
      }
    });

    it("goes to the developers only with its own consent, and only small enough", async () => {
      await (await as(manager)).feedback.setSharing({ enabled: true });
      const a = await as(ann);
      const annC = await cookieOf(ann);
      const { forwardQueued } = await import("../feedback/upstream");
      const items = () => posts().flatMap(c => (JSON.parse(c.body) as { items: { title: string; screenshot?: { type: string; data: string } }[] }).items);

      // Shared, the picture not: the text leaves, the picture stays here.
      const without = await a.feedback.create({ ...base, title: "Shared, picture kept", share: true, shareScreenshot: false, screenshot: true });
      expect((await upload(without.id, annC, PNG)).status).toBe(200);
      // Both agreed: the picture goes with it, as it was.
      const both = await a.feedback.create({ ...base, title: "Shared with its picture", share: true, shareScreenshot: true, screenshot: true });
      expect((await upload(both.id, annC, PNG)).status).toBe(200);
      // Agreed, but larger than the inbox takes (300 KB): the text leaves, the picture stays.
      const big = await a.feedback.create({ ...base, title: "Too big a picture", share: true, shareScreenshot: true, screenshot: true });
      const large = new Uint8Array(400 * 1024);
      large.set(PNG);
      expect((await upload(big.id, annC, large)).status).toBe(200);
      await forwardQueued();
      expect(items().find(i => i.title === "Shared, picture kept")).not.toHaveProperty("screenshot");
      expect(items().find(i => i.title === "Too big a picture")).not.toHaveProperty("screenshot");
      const shot = items().find(i => i.title === "Shared with its picture")?.screenshot;
      expect(shot?.type).toBe("image/png");
      expect(new Uint8Array(Buffer.from(shot?.data ?? "", "base64"))).toEqual(PNG);
    });
  });

  it("Send now: only manageFeedback, only with sharing on, at most every few minutes; it sends the consented queue", async () => {
    await expect((await as(manager)).feedback.sendNow()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect((await as(ann)).feedback.sendNow()).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { setSharing } = await import("../feedback/upstream");
    await setSharing(true);
    await (await as(ann)).feedback.create({ ...base, share: true });
    const r = await (await as(manager)).feedback.sendNow();
    expect(r.sent).toBe(1);
    await expect((await as(manager)).feedback.sendNow()).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});
