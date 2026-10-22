import { createHmac } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { instant, markdown, timeZone } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { ProviderError } from "../core/errors";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import { giteaSimulator, type GiteaSimOptions } from "./simulator";
import { giteaProvider } from "./adapter";
import { giteaWebhook } from "./webhook";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

// A fixed "now", so windows and checkpoints don't depend on the day the tests run.
const NOW = Date.UTC(2026, 9, 20, 10, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;
afterAll(() => vi.useRealTimers());

function simulated(options: GiteaSimOptions = {}, token = "gt_test") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const sim = giteaSimulator(undefined, undefined, options);
  sim.add("acme/web", "Login fails on Safari", { body: "Steps:\n\n1. open\n2. **fail**" });
  sim.add("acme/web", "Export to CSV");
  // A pull request: an issue too, for Gitea's issues API.
  sim.add("acme/web", "A pull request", { pr: true });
  sim.add("acme/api", "Someone else's", { assignee: null });
  sim.add("acme/api", "Already shipped", { state: "closed" });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 9,
    userId: 1,
    type: "gitea" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: String(sim.me.id),
    options: {},
    timeZone: timeZone("Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token }),
  };
  return { sim, conn, b: bindTracker(giteaProvider, conn) };
}

trackerConformance("gitea (simulated)", async () => {
  const { conn } = simulated();
  return { provider: giteaProvider, conn, key: "acme/web#1", writable: true, url: "https://git.example.com/acme/web/issues/1" };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const kindOf = async (p: Promise<unknown>) => (await p.then(() => "ok", (e: unknown) => (e instanceof ProviderError ? e.kind : String(e))));
const ref = (key: string, remoteId = "0") => ({ remoteId, key });

describe("gitea, as the layer sees it", () => {
  it("syncs the issues assigned to the user (no pull requests), then only what changed since the checkpoint", async () => {
    const { sim, b } = simulated();
    vi.setSystemTime(NOW + 10 * MIN);
    const first = await readPass((q) => b.listChanged(meta(), q), null);
    expect(first.items.map((i) => [i.key, i.status.name]).sort()).toEqual([
      ["acme/api#2", "Closed"],
      ["acme/web#1", "Open"],
      ["acme/web#2", "Open"],
    ]);
    expect(first.checkpoint).not.toBeNull();
    // Nothing changed: nothing comes back (the overlap is a minute, not ten).
    expect((await readPass((q) => b.listChanged(meta(), q), first.checkpoint)).items).toEqual([]);

    vi.setSystemTime(NOW + 20 * MIN);
    const second = sim.issues.find((i) => i.title === "Export to CSV")!;
    sim.outside.comment(second, "Reproduced");
    const next = await readPass((q) => b.listChanged(meta(), q), first.checkpoint);
    expect(next.items.map((i) => i.key)).toEqual(["acme/web#2"]);
    // `since` goes out as UTC with a Z: a "+02:00" would turn into a space in the query string and be refused (422).
    const asked = new URLSearchParams(sim.requests.filter((r) => r.path.endsWith("/repos/issues/search")).at(-1)!.search).get("since");
    expect(asked).toBe(new Date(NOW + 10 * MIN - MIN).toISOString().replace(".000Z", "Z"));
    const raw = await sim.fetch(`${sim.apiBase}/repos/issues/search?since=2026-10-20T10:00:00+02:00`, { headers: { Authorization: "token gt_test" } });
    expect(raw.status).toBe(422);
  });

  it("follows Link headers, not page counts: a ceiling under the page asked and a ROOT_URL naming another host change nothing", async () => {
    const { sim, b } = simulated({ maxLimit: 20, rootUrl: "http://localhost:3000" });
    for (let n = 0; n < 45; n++) sim.add("acme/big", `Item ${n}`);
    const issue = sim.issues.find((i) => i.title === "Login fails on Safari")!;
    for (let n = 0; n < 45; n++) sim.outside.comment(issue, `Comment ${n}`);
    const all = await readPass((q) => b.listChanged(meta(), q), null);
    expect(new Set(all.items.map((i) => i.key)).size).toBe(45 + 3);
    expect(all.pages).toBe(3);
    // Comments are read by following Link: its host (localhost:3000) is replaced by the connection's.
    expect(await b.comments!.list(meta(), ref("acme/web#1"))).toHaveLength(45);
    expect(new Set(sim.requests.map((r) => r.origin))).toEqual(new Set(["https://git.example.com"]));
  });

  it("keeps the repositories the user leaves out of the sync out", async () => {
    const { conn } = simulated();
    const narrow = bindTracker(giteaProvider, { ...conn, options: { excludeRepos: ["ACME/api"] } });
    expect((await readPass((q) => narrow.listChanged(meta(), q), null)).items.map((i) => i.key).sort()).toEqual(["acme/web#1", "acme/web#2"]);
  });

  it("reads keys and web links, finds the issue; a pull request is not an issue though the API says so", async () => {
    const { b } = simulated();
    expect(b.parseRef("acme/web#12")).toEqual({ key: "acme/web#12" });
    expect(b.parseRef("https://git.example.com/acme/web/issues/12#issuecomment-5")).toEqual({ key: "acme/web#12" });
    expect(b.parseRef("https://git.example.com/acme/web/pulls/3")).toBeNull();
    expect(b.parseRef("https://elsewhere.example/acme/web/issues/1")).toBeNull();
    // Under a sub-path (https://host/gitea), the prefix belongs to the site, not to the owner.
    const ctx = { baseUrl: "https://host.example/gitea/api/v1", options: { excludeRepos: [] } };
    expect(giteaProvider.parseRef(ctx, "https://host.example/gitea/acme/web/issues/3")).toEqual({ key: "acme/web#3" });
    expect(giteaProvider.parseRef(ctx, "https://host.example/acme/web/issues/3")).toBeNull();

    const found = await b.findIssue(meta(), b.parseRef("https://git.example.com/acme/web/issues/1")!);
    expect(found.kind === "found" && found.issue.title).toBe("Login fails on Safari");
    // acme/web#3 is a pull request: shares the numbering, answers on the issue path, and is left out.
    expect((await b.findIssue(meta(), { key: "acme/web#3" })).kind).toBe("none");
    expect(await b.getIssue(meta(), ref("acme/web#3"))).toBeNull();
    // A repository the user can't see is a 404 like one that doesn't exist.
    expect((await b.findIssue(meta(), { key: "nobody/nothing#1" })).kind).toBe("none");
    expect((await b.findIssue(meta(), { remoteId: "1001" })).kind).toBe("none");
  });

  it("tells the global id from the per-repository index; a renamed repository keeps the id, takes a new key, and its old key still resolves", async () => {
    const { sim, b } = simulated();
    const before = await b.findIssue(meta(), { key: "acme/web#2" });
    if (before.kind !== "found") throw new Error("no issue");
    expect(before.issue.remoteId).toBe(String(sim.issues[1].id));
    expect(before.issue.remoteId).not.toBe("2");
    sim.outside.rename("acme/web", "acme/website");
    const after = await b.findIssue(meta(), { key: "acme/web#2" });
    if (after.kind !== "found") throw new Error("no issue");
    expect(after.issue).toMatchObject({ remoteId: before.issue.remoteId, key: "acme/website#2", container: { key: "acme/website" } });
    // The container is the repository by its id: it stays when the name goes.
    expect(after.issue.container.remoteId).toBe(before.issue.container.remoteId);
    // Writes follow the redirect too (307 keeps the method and the body).
    const done = await b.transitions!.apply!(meta(), ref("acme/web#2"), "closed", {});
    expect(done?.key).toBe("acme/website#2");
  });

  it("maps open/closed to categories, moves along them, and answers an archived repository's refusal as forbidden", async () => {
    const { sim, b } = simulated();
    const r = ref("acme/web#1");
    const [close] = await b.transitions!.list!(meta(), r);
    expect(close).toMatchObject({ id: "closed", name: "Close", to: { name: "Closed", category: "done", source: { kind: "boolean" } } });
    // The edit answers 201: a success all the same.
    const closed = await b.transitions!.apply!(meta(), r, "closed", {});
    expect(closed?.status).toMatchObject({ category: "done" });
    expect(closed?.statusChangedAt).not.toBeNull();
    const [reopen] = await b.transitions!.list!(meta(), r);
    expect(reopen).toMatchObject({ id: "open", name: "Reopen", to: { category: "todo" } });
    expect((await b.transitions!.apply!(meta(), r, "open", {}))?.status.category).toBe("todo");
    expect(await kindOf(b.transitions!.apply!(meta(), r, "bogus", {}))).toBe("invalid");

    sim.repo("acme/web", { archived: true });
    expect(await kindOf(b.transitions!.apply!(meta(), r, "closed", {}))).toBe("forbidden");
    expect(await kindOf(b.comments!.add!(meta(), r, markdown("late"), { idempotencyKey: "k" }))).toBe("forbidden");
    // Reading still works.
    expect((await b.getIssue(meta(), r))?.status.category).toBe("todo");
  });

  it("reads issues with nobody assigned (null, not a list), labels and the description", async () => {
    const { sim, b } = simulated();
    const lonely = sim.issues.find((i) => i.title === "Someone else's")!;
    sim.outside.label(lonely, "scope/bug");
    const found = await b.findIssue(meta(), { key: "acme/api#1" });
    if (found.kind !== "found") throw new Error("no issue");
    expect(found.issue).toMatchObject({ assignees: [], labels: ["scope/bug"], reporter: { name: "Mario Rossi", handle: "mrossi" }, priority: null });
    expect(await b.description!(meta(), ref("acme/web#1"))).toEqual({ kind: "text", format: "gfm", text: "Steps:\n\n1. open\n2. **fail**" });
    expect(await b.description!(meta(), ref("acme/web#2"))).toBeNull();
  });

  it("writes comments as markdown and reads them back; a deleted author is Ghost", async () => {
    const { sim, b } = simulated();
    const r = ref("acme/web#1");
    const stranger = sim.user({ id: 31, login: "anna-b", full_name: "Anna Bianchi" });
    const issue = sim.issues[0];
    sim.outside.comment(issue, "From Anna", stranger.id);
    const added = await b.comments!.add!(meta(), r, markdown("Looks **fixed**"), { idempotencyKey: "c1" });
    expect(added.warnings).toEqual([]);
    expect((await b.comments!.list(meta(), r)).map((c) => [c.author.name, c.body])).toEqual([
      ["Anna Bianchi", { kind: "text", format: "gfm", text: "From Anna" }],
      ["Mario Rossi", { kind: "text", format: "gfm", text: "Looks **fixed**" }],
    ]);
    sim.outside.deleteUser(stranger.id);
    expect((await b.comments!.list(meta(), r))[0].author).toMatchObject({ remoteId: "-1", name: "Ghost" });
  });

  it("logs time as an entry with a start and seconds, reads it back in the server's own offset, never keeps a note", async () => {
    const { sim, b } = simulated({ utcOffsetMinutes: 540 });
    const r = ref("acme/web#1");
    const start = instant(Date.UTC(2026, 9, 14, 8, 30));
    const made = await b.worklogs!.create!(meta(), r, { time: { kind: "session", start, seconds: 5400 }, comment: "pairing" }, { idempotencyKey: "w1" });
    expect(made).toMatchObject({ span: { kind: "session", start, seconds: 5400 }, comment: "", authorRemoteId: String(sim.me.id), editable: { update: false, delete: true } });
    // The server writes +09:00, never Z: the same instant.
    const raw = await (await sim.fetch(`${sim.apiBase}/repos/acme/web/issues/1/times`, { headers: { Authorization: "token gt_test" } })).text();
    expect(raw).toContain('"created":"2026-10-14T17:30:00+09:00"');
    expect((await b.worklogs!.list(meta(), r))[0].span).toEqual({ kind: "session", start, seconds: 5400 });
    // No update: a changed entry is deleted and logged again by the engine.
    expect(b.worklogs!.update).toBeUndefined();
    expect(await kindOf(b.worklogs!.create!(meta(), r, { time: { kind: "date", date: "2026-10-14" as never, seconds: 60 }, comment: "" }, { idempotencyKey: "w2" }))).toBe("invalid");
    await b.worklogs!.delete!(meta(), r, made.remoteId, {});
    await b.worklogs!.delete!(meta(), r, made.remoteId, {});
    expect(await b.worklogs!.list(meta(), r)).toEqual([]);
  });

  it("offers deleting one's own entries only; another person's is read, not editable, and refused", async () => {
    const { sim, b } = simulated();
    const anna = sim.user({ id: 31, login: "anna-b", full_name: "Anna Bianchi" });
    const issue = sim.issues[0];
    const mine = sim.time(issue, { seconds: 600, created: NOW - DAY });
    const hers = sim.time(issue, { seconds: 1200, created: NOW - DAY, userId: anna.id });
    const list = await b.worklogs!.list(meta(), ref("acme/web#1"));
    expect(list.map((w) => [w.remoteId, w.authorRemoteId, w.editable.delete])).toEqual([
      [String(mine.id), String(sim.me.id), true],
      [String(hers.id), String(anna.id), false],
    ]);
    expect(await kindOf(b.worklogs!.delete!(meta(), ref("acme/web#1"), String(hers.id), {}))).toBe("forbidden");
  });

  it("re-reads the user's times over the window (30 days and a day), whatever repository they are in", async () => {
    const { sim, b } = simulated();
    const web = sim.issues[0];
    const api = sim.issues.find((i) => i.title === "Already shipped")!;
    const recent = sim.time(web, { seconds: 600, created: NOW - 10 * DAY });
    const other = sim.time(api, { seconds: 900, created: NOW - DAY });
    sim.time(web, { seconds: 300, created: NOW - 40 * DAY });
    const first = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    expect(first.items.map((w) => [w.remoteId, w.issue]).sort()).toEqual(
      [
        [String(recent.id), { remoteId: String(web.id), key: "acme/web#1", container: { remoteId: "1", key: "acme/web" } }],
        [String(other.id), { remoteId: String(api.id), key: "acme/api#2", container: { remoteId: "2", key: "acme/api" } }],
      ].sort(),
    );
    expect(first.gone).toEqual([]);
    // Taken back on the server: the window read again no longer has it. No removal is reported (the engine's reconciliation finds it).
    sim.outside.removeTime(recent.id);
    const again = await readPass((q) => b.worklogs!.changed!(meta(), q), first.checkpoint);
    expect(again.items.map((w) => w.remoteId)).toEqual([String(other.id)]);
    expect(again.gone).toEqual([]);
  });

  it("pages the window through Link too", async () => {
    const { sim, b } = simulated({ maxLimit: 20 });
    for (let n = 0; n < 45; n++) sim.time(sim.issues[0], { seconds: 60, created: NOW - DAY });
    const pass = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    expect(pass.items).toHaveLength(45);
    expect(pass.pages).toBe(3);
  });

  it("says why time can't be logged: switched off on the repository, or no permission", async () => {
    const { sim, b } = simulated();
    const r = ref("acme/web#1");
    const input = { time: { kind: "session" as const, start: instant(NOW), seconds: 60 }, comment: "" };
    sim.repo("acme/web", { timeTracking: false });
    // 400 "time tracking disabled" is a setting of the repository, told as forbidden.
    const off = await b.worklogs!.create!(meta(), r, input, { idempotencyKey: "k" }).catch((e: unknown) => e);
    expect(off).toMatchObject({ kind: "forbidden", status: 400 });
    expect(await kindOf(b.worklogs!.list(meta(), r))).toBe("forbidden");
    sim.repo("acme/web", { timeTracking: true, canWrite: false });
    sim.issues[0].assignees = [];
    expect(await kindOf(b.worklogs!.create!(meta(), r, input, { idempotencyKey: "k" }))).toBe("forbidden");
  });

  it("subscribes and unsubscribes; doing either twice is a success (200 or 201)", async () => {
    const { sim, b } = simulated();
    const r = ref("acme/web#1");
    for (const on of [true, true, false, false]) await b.watch!(meta(), r, on);
    expect(sim.issues[0].subscribers.size).toBe(0);
    await b.watch!(meta(), r, true);
    expect(sim.issues[0].subscribers.has(sim.me.id)).toBe(true);
  });

  it("reads the history from the timeline: state, title, labels, assignees", async () => {
    const { sim, b } = simulated();
    const i = sim.issues[0];
    sim.outside.close(i);
    sim.outside.reopen(i);
    sim.outside.retitle(i, "Login fails on Safari 18");
    sim.outside.label(i, "bug");
    sim.outside.label(i, "bug", false);
    sim.outside.assign(i, sim.me.id, false);
    const changes = await b.history!(meta(), ref("acme/web#1"));
    expect(changes.map((c) => [c.field.name, c.from.map((v) => v.text), c.to.map((v) => v.text)])).toEqual([
      ["State", ["Open"], ["Closed"]],
      ["State", ["Closed"], ["Open"]],
      ["Title", ["Login fails on Safari"], ["Login fails on Safari 18"]],
      ["Labels", [], ["bug"]],
      ["Labels", ["bug"], []],
      ["Assignees", ["Mario Rossi"], []],
    ]);
    expect(changes[0].actor?.name).toBe("Mario Rossi");
  });

  it("searches by text: complete when the server has no more, cut short when it has", async () => {
    const { sim, b } = simulated();
    const hit = await b.searchText!(meta(), "export", 10);
    expect(hit.items.map((i) => i.key)).toEqual(["acme/web#2"]);
    expect(hit.complete).toBe(true);
    // Pull requests never show.
    expect((await b.searchText!(meta(), "pull request", 10)).items).toEqual([]);
    sim.add("acme/web", "Export to PDF");
    const cut = await b.searchText!(meta(), "export", 1);
    expect(cut.items).toHaveLength(1);
    expect(cut.complete).toBe(false);
  });

  it("searches only the issues the user created, is assigned to or is mentioned in, outside the repositories left out", async () => {
    const { sim, conn } = simulated();
    const anna = sim.user({ id: 8, login: "anna-b", full_name: "Anna Bianchi" });
    sim.add("stranger/repo", "Export from another team", { assignee: null, author: anna.id });
    sim.add("stranger/repo", "Export review", { assignee: null, author: anna.id, body: "cc @mrossi" });
    sim.add("acme/left", "Export left out", { assignee: null });
    const b = bindTracker(giteaProvider, { ...conn, options: { excludeRepos: ["acme/left"] } });
    const hit = await b.searchText!(meta(), "export", 10);
    expect(hit.items.map((i) => i.key).sort()).toEqual(["acme/web#2", "stranger/repo#2"]);
    expect(hit.complete).toBe(true);
    const asked = sim.requests.filter((r) => r.path.endsWith("/repos/issues/search")).map((r) => new URLSearchParams(r.search));
    expect(asked.map((p) => ["created", "assigned", "mentioned"].filter((k) => p.get(k) === "true"))).toEqual([["created"], ["assigned"], ["mentioned"]]);
  });

  it("knows who the token belongs to, authenticates as 'token <t>', has no rate budget of its own", async () => {
    const { sim, b } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: String(sim.me.id), name: "Mario Rossi", login: "mrossi", email: "mario@example.com" });
    const probe = await b.probe(meta());
    expect(probe.rateLimit).toBeUndefined();
    expect(probe.activeSources).toMatchObject([{ kind: "boolean", reasons: false }]);
    expect(sim.requests[0].headers.authorization).toBe("token gt_test");
  });
});

describe("gitea, when the service says no", () => {
  it("401 for a refused token is auth", async () => {
    const { b } = simulated({}, "wrong");
    expect(await kindOf(b.verify(meta()))).toBe("auth");
    expect(await kindOf(b.listChanged(meta(), { since: null, page: null }))).toBe("auth");
  });

  it("a token missing a scope is forbidden, naming the scope", async () => {
    const { sim, conn, b } = simulated({}, "gt_read");
    sim.token("gt_read", ["read:user", "read:issue"]);
    expect((await b.verify(meta())).remoteId).toBe(String(sim.me.id));
    expect((await b.getIssue(meta(), ref("acme/web#1")))?.title).toBe("Login fails on Safari");
    const err = await b.comments!.add!(meta(), ref("acme/web#1"), markdown("x"), { idempotencyKey: "k" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "forbidden", status: 403 });
    expect((err as Error).message).toContain("write:issue");
    sim.token("gt_none", ["read:user"]);
    const blind = bindTracker(giteaProvider, { ...conn, credential: async () => ({ kind: "token" as const, token: "gt_none" }) });
    expect(await kindOf(blind.listChanged(meta(), { since: null, page: null }))).toBe("forbidden");
  });

  it("429 from a proxy in front is a wait, with when to retry", async () => {
    const { sim, b } = simulated();
    sim.failNext(429, { "Retry-After": "30" }, { message: "slow down" });
    const err = await b.verify(meta()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 30_000 } });
    // A spent 403 with the usual headers is a wait too, not a refusal.
    sim.failNext(403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.ceil(Date.now() / 1000) + 120) }, { message: "limit" });
    const spent = await b.verify(meta()).catch((e: unknown) => e);
    expect(spent).toMatchObject({ kind: "rateLimit" });
    expect((spent as ProviderError).rateLimit?.retryAfterMs).toBeGreaterThan(60_000);
  });

  it("404 is notFound; a repository lost to the user is the same 404", async () => {
    const { sim, b } = simulated();
    expect(await kindOf(b.comments!.list(meta(), ref("acme/web#99")))).toBe("notFound");
    sim.outside.revokeAccess("acme/web");
    expect(await kindOf(b.comments!.list(meta(), ref("acme/web#1")))).toBe("notFound");
    expect(await b.getIssue(meta(), ref("acme/web#1"))).toBeNull();
    // Its issues leave the assigned feed: the engine's reconciliation finds them missing (no reason is reported).
    const pass = await readPass((q) => b.listChanged(meta(), q), null);
    expect(pass.items.map((i) => i.key)).toEqual(["acme/api#2"]);
    expect(pass.gone).toEqual([]);
  });

  it("a server error is unavailable", async () => {
    const { sim, b } = simulated();
    sim.failNext(502, {}, { message: "bad gateway" });
    expect(await kindOf(b.verify(meta()))).toBe("unavailable");
  });
});

describe("gitea webhooks", () => {
  const secret = "s3cret";
  const payload = JSON.stringify({ action: "created", comment: { id: 5, updated_at: "2026-10-20T12:00:00+02:00" }, issue: { number: 1 } });
  const sign = (body: string, key = secret) => createHmac("sha256", key).update(body).digest("hex");
  const headers = (body: string, extra: Record<string, string> = {}) => ({ "X-Gitea-Signature": sign(body), "X-Gitea-Delivery": "6f1c0e52-0000-4000-8000-000000000001", "X-Gitea-Event": "issue_comment", ...extra });

  it("accepts a body signed with the secret (hex HMAC-SHA256), in any header case, from Gitea or Forgejo", () => {
    expect(giteaWebhook.verify(secret, payload, headers(payload))).toBe(true);
    expect(giteaWebhook.verify(secret, payload, { "x-gitea-signature": sign(payload).toUpperCase() })).toBe(true);
    expect(giteaWebhook.verify(secret, Buffer.from(payload), { "x-forgejo-signature": sign(payload) })).toBe(true);
    expect(giteaWebhook.verify(secret, payload, new Headers(headers(payload)))).toBe(true);
  });

  it("refuses a wrong secret, a changed body, a missing, a short or a prefixed signature", () => {
    expect(giteaWebhook.verify(secret, payload, headers(payload, { "X-Gitea-Signature": sign(payload, "other") }))).toBe(false);
    expect(giteaWebhook.verify(secret, `${payload} `, headers(payload))).toBe(false);
    expect(giteaWebhook.verify(secret, payload, {})).toBe(false);
    expect(giteaWebhook.verify(secret, payload, { "x-gitea-signature": "abc" })).toBe(false);
    expect(giteaWebhook.verify(secret, payload, { "x-gitea-signature": `sha256=${sign(payload)}` })).toBe(false);
    expect(giteaWebhook.verify("", payload, headers(payload))).toBe(false);
  });

  it("reads the delivery id, the event, and when it happened", () => {
    expect(giteaWebhook.deliveryId(headers(payload))).toBe("6f1c0e52-0000-4000-8000-000000000001");
    expect(giteaWebhook.deliveryId({})).toBeNull();
    expect(giteaWebhook.canonicalEvent(giteaWebhook.event(headers(payload)))).toBe("commentAdded");
    expect(giteaWebhook.canonicalEvent("issues")).toBe("issueChanged");
    expect(giteaWebhook.canonicalEvent("push")).toBeNull();
    expect(giteaWebhook.sentAt(payload)).toBe(Date.UTC(2026, 9, 20, 10, 0, 0));
    expect(giteaWebhook.sentAt("not json")).toBeNull();
  });
});
