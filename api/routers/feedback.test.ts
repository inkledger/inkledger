import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = ":memory:";
process.env.STORE_URL = "https://store.test";
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

/** What reached the Store, and what it answers next. */
type Call = { url: string; method: string; headers: Record<string, string>; body: string };
const store = { calls: [] as Call[], post: (): Response => json({ ok: true }), status: (): Response => json({ items: [] }) };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
/** The signature the Worker checks (store/src/worker.ts), checked the same way here. */
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
      if (url.startsWith("https://store.test/feedback/status")) return store.status();
      if (url === "https://store.test/feedback") return store.post();
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
    store.post = () => json({ ok: true });
    store.status = () => json({ items: [] });
    const { setSharing } = await import("../feedback/upstream");
    await setSharing(false);
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

  it("leaves anonymised and signed with this server's key, once", async () => {
    await (await as(manager)).feedback.setSharing({ enabled: true });
    const a = await as(ann);
    const { id } = await a.feedback.create({ ...base, share: true });
    await vi.waitFor(async () => expect((await a.feedback.get({ id })).shareState).toBe("sent"));
    const posts = store.calls.filter(c => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(signedByInstance(posts[0])).toBe(true);
    // A signature for another body (or path) is no signature.
    expect(signedByInstance({ ...posts[0], body: posts[0].body.replace("flickers", "flicker") })).toBe(false);

    const sent = JSON.parse(posts[0].body) as Record<string, unknown>;
    expect(sent).toMatchObject({ v: 1, type: "problem", title: base.title, body: base.body, route: "/issues/:id", look: base.look, density: "compact" });
    expect(sent).not.toHaveProperty("screenshot");
    const text = posts[0].body;
    for (const personal of ["person", "Person Number", "@example.com", "assignee", "ABC-12?q"]) expect(text).not.toContain(personal);
    expect(String(sent.user)).toMatch(/^[0-9a-f]{32}$/);

    // The same person, the same pseudonym; another person, another.
    const { userPseudonym } = await import("../feedback/upstream");
    expect(await userPseudonym(ann)).toBe(sent.user);
    expect(await userPseudonym(bob)).not.toBe(sent.user);
    const [row] = await q<{ uid: string }>("SELECT uid FROM feedback WHERE id = ?", id);
    expect(sent.id).toBe(row.uid);

    // Sent once: the next cycle has nothing queued.
    const { forwardQueued } = await import("../feedback/upstream");
    await forwardQueued();
    expect(store.calls.filter(c => c.method === "POST")).toHaveLength(1);
  });

  it("stays queued while the Store can't take it, and stops for good when it refuses its input", async () => {
    await (await as(manager)).feedback.setSharing({ enabled: true });
    const a = await as(ann);
    const { forwardQueued } = await import("../feedback/upstream");
    // Not published yet (404 without the Worker's own answer), or busy: tried again later.
    store.post = () => new Response("Not Found", { status: 404 });
    const { id } = await a.feedback.create({ ...base, title: "Later", screenshot: true, share: true });
    await forwardQueued({ ids: [id] });
    expect((await a.feedback.get({ id })).shareState).toBe("queued");
    store.post = () => json({ error: "rate" }, 429);
    await forwardQueued({ ids: [id] });
    expect((await a.feedback.get({ id })).shareState).toBe("queued");
    store.post = () => json({ error: "input" }, 400);
    await forwardQueued({ ids: [id] });
    expect((await a.feedback.get({ id })).shareState).toBe("refused");
    // Turned off: nothing more leaves, even what is queued.
    store.post = () => json({ ok: true });
    await q("UPDATE feedback SET share_state = 'queued' WHERE id = ?", id);
    await (await as(manager)).feedback.setSharing({ enabled: false });
    store.calls.length = 0;
    await forwardQueued();
    expect(store.calls).toEqual([]);
  });

  it("reads back the developers' state and replies, without undoing what an admin here decided", async () => {
    await (await as(manager)).feedback.setSharing({ enabled: true });
    const a = await as(ann);
    const { id } = await a.feedback.create({ ...base, title: "Synced", share: true });
    await vi.waitFor(async () => expect((await a.feedback.get({ id })).shareState).toBe("sent"));
    const [{ uid }] = await q<{ uid: string }>("SELECT uid FROM feedback WHERE id = ?", id);
    const { syncStatuses } = await import("../feedback/upstream");
    let answer = { status: "accepted", replies: [{ id: "c1", body: "Thanks, we'll look at it.", at: 1_700_000_000_000 }] };
    store.status = () => json({ items: [{ id: uid, ...answer }, { id: "someone-else", status: "rejected", replies: [] }] });

    await syncStatuses();
    const gets = store.calls.filter(c => c.method === "GET");
    expect(gets).toHaveLength(1);
    expect(new URL(gets[0].url).searchParams.get("ids")).toContain(uid);
    expect(signedByInstance(gets[0])).toBe(true);
    let f = await a.feedback.get({ id });
    expect(f.status).toBe("accepted");
    expect(f.thread.filter(c => c.origin === "upstream" && !c.statusTo).map(c => c.body)).toEqual(["Thanks, we'll look at it."]);
    expect(f.thread.filter(c => c.origin === "upstream" && c.statusTo).map(c => [c.statusFrom, c.statusTo])).toEqual([["new", "accepted"]]);

    // Read again: nothing new, nothing twice.
    await syncStatuses();
    f = await a.feedback.get({ id });
    expect(f.thread.filter(c => c.origin === "upstream" && !c.statusTo)).toHaveLength(1);
    expect(f.thread.filter(c => c.origin === "upstream" && c.statusTo)).toHaveLength(1);

    // An admin here moves it; the developers' unchanged state doesn't move it back.
    await (await as(manager)).feedback.setStatus({ id, status: "in_progress" });
    await syncStatuses();
    expect((await a.feedback.get({ id })).status).toBe("in_progress");

    // The developers move it: that is news, applied.
    answer = { status: "implemented", replies: answer.replies };
    await syncStatuses();
    f = await a.feedback.get({ id });
    expect(f.status).toBe("implemented");
    const told = (await a.notifications.alerts()).filter(n => n.alert === "feedback" && n.ref === id);
    expect(told.some(n => n.what === "comment")).toBe(true);
    expect(told.filter(n => n.what === "status").length).toBeGreaterThanOrEqual(3);
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
    expect(js.items.map(i => i.title)).toEqual(["Bob's own"]);
    const logged = await events("feedback.export");
    expect(logged.map(e => JSON.parse(e.after ?? "{}") as { scope: string })).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "mine" }), expect.objectContaining({ scope: "all" })]));
  });
});
