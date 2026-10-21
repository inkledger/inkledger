import { describe, expect, it, vi } from "vitest";
import { instant, localDate, markdown, timeZone } from "@contracts/values";
import { toRichDoc } from "../core/richtext";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import { basecampSimulator, type SimRecording } from "./simulator";
import { basecampProvider, basecampWebhook, toBasecampHtml } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "198.51.100.7", family: 4 }]),
}));

const COLUMNS = { options: { columns: { Doing: "doing", Backlog: "backlog" } } };

function simulated(o: { options?: unknown; token?: string; zone?: string; bare?: boolean } = {}) {
  const sim = basecampSimulator();
  const web = sim.project("Website", { columns: ["Backlog", "Doing", "Review"] });
  const marketing = sim.project("Marketing");
  sim.add("Login fails on Safari", { project: web, dueOn: "2026-11-05", description: "<div>Steps</div>" });
  sim.add("Export to CSV", { project: web });
  sim.add("Fix the header", { project: web, kind: "Kanban::Card", column: "Doing", description: "<div>Sticky</div>" });
  sim.add("Newsletter copy", { project: marketing });
  // Someone else's, and one I wrote for someone else: not assigned to me.
  sim.add("Anna's", { project: web, assignees: [sim.anna.id] });
  sim.add("Delegated", { project: web, assignees: [sim.anna.id], author: sim.me.id });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 9,
    userId: 1,
    type: "basecamp" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: String(sim.me.id),
    options: o.options ?? {},
    timeZone: timeZone(o.zone ?? "Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, web, marketing, conn, b: bindTracker(basecampProvider, conn) };
}

type Sim = ReturnType<typeof basecampSimulator>;

trackerConformance("basecamp (simulated)", async () => {
  const { conn, sim } = simulated();
  return { provider: basecampProvider, conn, key: sim.keyOf(sim.recs[0]), writable: true, url: sim.urlOf(sim.recs[0]) };
});

trackerConformance("basecamp (simulated, columns as statuses)", async () => {
  const { conn, sim } = simulated(COLUMNS);
  return { provider: basecampProvider, conn, key: sim.keyOf(sim.recs[2]), writable: true, url: sim.urlOf(sim.recs[2]) };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const pass = (b: ReturnType<typeof simulated>["b"], since: Parameters<typeof b.listChanged>[1]["since"] = null) => readPass((q) => b.listChanged(meta(), q), since);
const ref = (r: SimRecording) => ({ remoteId: String(r.id), key: `BC-${r.bucket}-${r.id}` });
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; rateLimit?: { retryAfterMs?: number; remaining?: number }; message: string });
const raw = (sim: Sim, path: string, init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) =>
  sim.fetch(`${sim.apiBase}/${sim.accountId}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${sim.token}`, "User-Agent": "test (t@example.org)", ...init.headers },
    ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
  });

describe("basecamp, to-dos and cards", () => {
  it("lists what is assigned to the user and open, to-dos and cards, keyed by project and id", async () => {
    const { b, sim, web } = simulated();
    const all = await pass(b);
    expect(all.items.map((i) => [i.key, i.title, i.type.name, i.status.name, i.status.category, i.container.name])).toEqual([
      [`BC-${web.id}-${sim.recs[0].id}`, "Login fails on Safari", "To-do", "Open", "todo", "Website"],
      [`BC-${web.id}-${sim.recs[1].id}`, "Export to CSV", "To-do", "Open", "todo", "Website"],
      [`BC-${web.id}-${sim.recs[2].id}`, "Fix the header", "Card", "Open", "todo", "Website"],
      [`BC-${sim.recs[3].bucket}-${sim.recs[3].id}`, "Newsletter copy", "To-do", "Open", "todo", "Marketing"],
    ]);
    const first = all.items[0];
    expect(first).toMatchObject({ remoteId: String(sim.recs[0].id), due: "2026-11-05", container: { remoteId: String(web.id), kind: "project" }, url: sim.urlOf(sim.recs[0]) });
    expect(first.assignees[0]).toMatchObject({ name: "Mario Rossi", remoteId: String(sim.me.id) });
    expect(first.reporter).toMatchObject({ name: "Mario Rossi" });
    expect(await b.description!(meta(), ref(sim.recs[0]))).toEqual({ kind: "text", format: "html", text: "<div>Steps</div>" });
    expect(await b.description!(meta(), ref(sim.recs[2]))).toEqual({ kind: "text", format: "html", text: "<div>Sticky</div>" });
    expect(await b.description!(meta(), ref(sim.recs[1]))).toBeNull();
  });

  it("the assignments list has no completed to-do and no one else's: a completed one comes with the next pass", async () => {
    const { b, sim } = simulated();
    const done = sim.add("Already done", { project: sim.projects.values().next().value! });
    sim.outside.complete(done);
    expect((await pass(b)).items.map((i) => i.title)).not.toContain("Already done");
    expect((await b.getIssue(meta(), ref(done)))?.status).toMatchObject({ name: "Completed", category: "done" });
  });

  it("timestamps carry the account's UTC offset, not Z: read as the instants they are", async () => {
    const { b, sim } = simulated();
    const r = sim.recs[0];
    const body = (await (await raw(sim, `/buckets/${r.bucket}/todos/${r.id}.json`)).json()) as { updated_at: string };
    expect(body.updated_at).toMatch(/\.\d{3}\+02:00$/);
    const got = await b.getIssue(meta(), ref(r));
    expect(got?.updatedAt).toBe(r.updated);
    expect(got?.createdAt).toBe(r.created);
  });

  it("reads a pass page by page (pages of 15, a Link to the next), then only what changed since its checkpoint", async () => {
    const { b, sim, web } = simulated();
    for (let n = 0; n < 40; n++) sim.add(`Bulk ${n}`, { project: web });
    const all = await pass(b);
    expect(all.pages).toBeGreaterThanOrEqual(3);
    expect(all.items.length).toBe(44);
    expect(new Set(all.items.map((i) => i.remoteId)).size).toBe(44);
    expect((await pass(b, all.checkpoint)).items).toEqual([]);
    sim.outside.retitle(sim.recs[0], "Login fails on Safari 18");
    const again = await pass(b, all.checkpoint);
    expect(again.items.map((i) => i.title)).toEqual(["Login fails on Safari 18"]);
  });

  it("the recordings feed is paged too, newest change first, and stops at the first one older than the checkpoint", async () => {
    const { b, sim, web } = simulated();
    for (let n = 0; n < 40; n++) sim.add(`Bulk ${n}`, { project: web });
    const first = await pass(b);
    for (const r of sim.recs.filter((x) => x.title.startsWith("Bulk")).slice(0, 20)) sim.outside.retitle(r, `${r.title} changed`);
    const calls = sim.state.calls;
    const later = await pass(b, first.checkpoint);
    expect(later.items.length).toBe(20);
    expect(later.items.every((i) => i.title.endsWith("changed"))).toBe(true);
    // 20 changed: two pages of the to-do feed (the second ends the walk), then the three others, one page each.
    expect(sim.state.calls - calls).toBeLessThanOrEqual(2 + 2 + 3);
  });

  it("the feed holds everybody's to-dos: what is not assigned to the user is left out, and what was unassigned from them is no longer theirs", async () => {
    const { b, sim } = simulated();
    const first = await pass(b);
    sim.outside.retitle(sim.recs[4], "Anna's, renamed");
    sim.outside.assign(sim.recs[1], [sim.anna.id]);
    sim.outside.retitle(sim.recs[0], "Mine, renamed");
    expect((await pass(b, first.checkpoint)).items.map((i) => i.title)).toEqual(["Mine, renamed"]);
    // Several people on a to-do: it is still the user's.
    sim.outside.assign(sim.recs[1], [sim.anna.id, sim.me.id]);
    const shared = await pass(b, first.checkpoint);
    expect(shared.items.find((i) => i.title === "Export to CSV")?.assignees.map((a) => a.name)).toEqual(["Anna Bianchi", "Mario Rossi"]);
  });

  it("a trashed to-do is still answered, with a status: it is not there, and the feed reports it gone", async () => {
    const { b, sim } = simulated();
    const first = await pass(b);
    const t = sim.recs[1];
    sim.outside.trash(t);
    expect((await raw(sim, `/buckets/${t.bucket}/todos/${t.id}.json`)).status).toBe(200);
    expect(await b.getIssue(meta(), ref(t))).toBeNull();
    expect((await b.findIssue(meta(), { key: sim.keyOf(t) })).kind).toBe("none");
    expect((await pass(b)).items.map((i) => i.title)).not.toContain("Export to CSV");
    expect(await errorOf(b.comments!.list(meta(), ref(t)))).toMatchObject({ kind: "notFound" });
    const next = await pass(b, first.checkpoint);
    expect(next.gone).toEqual([{ remoteId: String(t.id), reason: "deleted" }]);
    expect(next.items).toEqual([]);
    // Archived reads the same.
    sim.outside.archive(sim.recs[0]);
    expect(await b.getIssue(meta(), ref(sim.recs[0]))).toBeNull();
    // A trashed card too.
    sim.outside.trash(sim.recs[2]);
    expect((await pass(b, first.checkpoint)).gone.map((g) => g.remoteId)).toContain(String(sim.recs[2].id));
    sim.outside.restore(t);
    expect((await b.getIssue(meta(), ref(t)))?.title).toBe("Export to CSV");
  });

  it("a to-do moved to another project is a new recording with a new id and key; the old one is trashed", async () => {
    const { b, sim, marketing } = simulated();
    const first = await pass(b);
    const moved = sim.outside.moveToProject(sim.recs[1], marketing);
    const next = await pass(b, first.checkpoint);
    expect(next.items.map((i) => [i.remoteId, i.key, i.container.name])).toEqual([[String(moved.id), `BC-${marketing.id}-${moved.id}`, "Marketing"]]);
    expect(next.gone).toEqual([{ remoteId: String(sim.recs[1].id), reason: "deleted" }]);
    expect(moved.id).not.toBe(sim.recs[1].id);
  });

  it("a card is found though its path is not a to-do's (the wrong path is a 404), by key and by link", async () => {
    const { b, sim } = simulated();
    const card = sim.recs[2];
    expect((await raw(sim, `/buckets/${card.bucket}/todos/${card.id}.json`)).status).toBe(404);
    expect((await raw(sim, `/buckets/${card.bucket}/card_tables/cards/${sim.recs[0].id}.json`)).status).toBe(404);
    expect(await b.getIssue(meta(), ref(card))).toMatchObject({ title: "Fix the header", type: { id: "card" } });
    const handle = b.parseRef(sim.urlOf(card));
    const found = handle && (await b.findIssue(meta(), handle));
    expect(found && found.kind === "found" && found.issue.remoteId).toBe(String(card.id));
    expect((await b.getIssue(meta(), { remoteId: String(card.id), key: sim.keyOf(card), container: { remoteId: String(card.bucket), key: "Website" } }))?.type.id).toBe("card");
  });

  it("a project the user cannot reach is a 403, which reads as not there", async () => {
    const { b, sim, web } = simulated();
    const hidden = sim.recs[0];
    sim.outside.access(web, false);
    expect((await raw(sim, `/buckets/${hidden.bucket}/todos/${hidden.id}.json`)).status).toBe(403);
    expect(await b.getIssue(meta(), ref(hidden))).toBeNull();
    expect((await b.findIssue(meta(), { key: sim.keyOf(hidden) })).kind).toBe("none");
    expect((await pass(b)).items.map((i) => i.title)).toEqual(["Newsletter copy"]);
  });

  it("a renamed project changes only the container", async () => {
    const { b, sim, web } = simulated();
    const first = await pass(b);
    sim.outside.renameProject(web, "Website 2026");
    const next = await pass(b, first.checkpoint);
    expect(next.items.map((i) => [i.key, i.container.name, i.container.remoteId]).sort()).toEqual(
      sim.recs
        .filter((r) => r.bucket === web.id && r.assignees.includes(sim.me.id))
        .map((r) => [sim.keyOf(r), "Website 2026", String(web.id)])
        .sort(),
    );
  });

  it("searches the user's to-dos and cards: other people's and other kinds of recording are left out, the cut is said", async () => {
    const { b, sim, web } = simulated();
    sim.add("Export for Anna", { project: web, assignees: [sim.anna.id] });
    sim.add("Export announcement", { project: web, kind: "Message" });
    const r = await b.searchText!(meta(), "export", 10);
    expect(r.items.map((i) => i.title)).toEqual(["Export to CSV"]);
    expect(r.complete).toBe(true);
    const cut = await b.searchText!(meta(), "e", 1);
    expect(cut.items.length).toBe(1);
    expect(cut.complete).toBe(false);
  });

  it("a Link to another server is not followed (the token would go with it)", async () => {
    const { b, sim, web } = simulated();
    for (let n = 0; n < 20; n++) sim.add(`Bulk ${n}`, { project: web });
    const first = await pass(b);
    sim.hijackLinks("https://evil.example");
    for (const r of sim.recs.slice(0, 20)) sim.outside.retitle(r, `${r.title}!`);
    expect(await errorOf(pass(b, first.checkpoint))).toMatchObject({ kind: "incompatible" });
  });
});

describe("basecamp, the account and the calls", () => {
  it("sends a User-Agent: Basecamp refuses calls without one", async () => {
    const { b, sim } = simulated();
    const bare = await sim.fetch(`${sim.apiBase}/${sim.accountId}/my/profile.json`, { headers: { Authorization: `Bearer ${sim.token}` } });
    expect(bare.status).toBe(400);
    expect((await b.verify(meta())).remoteId).toBe(String(sim.me.id));
  });

  it("finds the account of the token at the launchpad when the options name none, only among Basecamp 3 and 4 accounts", async () => {
    const { b, sim } = simulated();
    sim.addAccount("hey", 777);
    sim.addAccount("bcx", 778);
    expect((await b.verify(meta())).name).toBe("Mario Rossi");
    expect((await pass(b)).items.length).toBe(4);
  });

  it("several Basecamp accounts on a token: the options must choose one", async () => {
    const { sim, conn } = simulated();
    sim.addAccount("bc3", 888);
    const none = bindTracker(basecampProvider, conn);
    expect(await errorOf(none.verify(meta()))).toMatchObject({ kind: "invalid", message: expect.stringContaining("2 accounts") });
    const chosen = bindTracker(basecampProvider, { ...conn, options: { account: sim.accountId } });
    expect((await chosen.verify(meta())).name).toBe("Mario Rossi");
    const other = bindTracker(basecampProvider, { ...conn, options: { account: "999" } });
    expect(await errorOf(other.verify(meta()))).toMatchObject({ kind: "notFound" });
  });

  it("a token with no Basecamp account is invalid", async () => {
    const { sim, conn } = simulated();
    sim.accountsOfToken.splice(0, sim.accountsOfToken.length, { product: "hey", id: 1, name: "Hey", href: "x" });
    expect(await errorOf(bindTracker(basecampProvider, conn).verify(meta()))).toMatchObject({ kind: "invalid" });
  });

  it("refuses options it can't read", () => {
    expect(() => basecampProvider.parseOptions({ account: "acme" })).toThrow(/account/);
    expect(() => basecampProvider.parseOptions({ columns: { x: "wip" } })).toThrow();
    expect(basecampProvider.parseOptions(undefined)).toEqual({ account: null, columns: {} });
    expect(basecampProvider.parseOptions({ account: "5001234", columns: { " Doing ": "doing" } })).toEqual({ account: "5001234", columns: { doing: "doing" } });
  });
});

describe("basecamp, keys and links", () => {
  it("reads keys, and the links of the web app (a to-do, a card, a comment's anchor)", () => {
    const { b } = simulated();
    expect(b.normalizeKey("bc-12-345")).toBe("BC-12-345");
    expect(b.normalizeKey("345")).toBeNull();
    expect(b.normalizeKey("BC-12")).toBeNull();
    expect(b.parseRef("https://3.basecamp.com/5001234/buckets/12/todos/345")).toEqual({ key: "BC-12-345", remoteId: "345" });
    expect(b.parseRef("https://3.basecamp.com/5001234/buckets/12/card_tables/cards/346")).toEqual({ key: "BC-12-346", remoteId: "346" });
    expect(b.parseRef("https://3.basecamp.com/5001234/buckets/12/todos/345#__recording_999")).toMatchObject({ key: "BC-12-345" });
    expect(b.parseRef("https://3.basecamp.com/5001234/buckets/12/messages/345")).toBeNull();
    expect(b.parseRef("https://3.basecamp.com/5001234/projects/12")).toBeNull();
    expect(b.parseRef("https://basecamp.example/5001234/buckets/12/todos/345")).toBeNull();
  });

  it("a link of another account than the one the options choose is not this connection's", () => {
    const { conn } = simulated({ options: { account: "5001234" } });
    const b = bindTracker(basecampProvider, conn);
    expect(b.parseRef("https://3.basecamp.com/5001234/buckets/12/todos/345")).toMatchObject({ key: "BC-12-345" });
    expect(b.parseRef("https://3.basecamp.com/42/buckets/12/todos/345")).toBeNull();
  });
});

describe("basecamp, workflow", () => {
  it("completes and reopens a to-do: open / completed as the only source with no card table", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.recs[0]);
    expect((await b.transitions!.list!(meta(), r)).map((t) => [t.name, t.to.category])).toEqual([["Complete", "done"]]);
    const done = await b.transitions!.apply!(meta(), r, "complete", {});
    expect(done?.status).toMatchObject({ name: "Completed", category: "done", categoryOrigin: { by: "native" } });
    expect(sim.recs[0].completed).toBe(true);
    expect((await b.transitions!.list!(meta(), r)).map((t) => [t.name, t.to.name, t.to.category])).toEqual([["Reopen", "Open", "todo"]]);
    expect((await b.transitions!.apply!(meta(), r, "reopen", {}))?.status.name).toBe("Open");
    expect(await errorOf(b.transitions!.apply!(meta(), r, "column:1", {}))).toMatchObject({ kind: "invalid" });
    expect((await b.statuses!(meta(), { kind: "boolean", transitions: "direct", reasons: false, ref: { kind: "boolean" }, name: "Open / completed" })).map((s) => s.name)).toEqual(["Open", "Completed"]);
  });

  it("a card's column is its status: Triage, Not now and Done have a category of their own, the others only what the options say", async () => {
    const { b, sim, web } = simulated(COLUMNS);
    const card = sim.recs[2];
    const r = ref(card);
    expect((await b.getIssue(meta(), r))?.status).toMatchObject({ name: "Doing", category: "doing", categoryOrigin: { by: "mapping" }, source: { kind: "column", boardRemoteId: String(web.id) } });
    const ways = await b.transitions!.list!(meta(), r);
    // Review is not in the options: no way there. Triage, Not now and Done always are.
    expect(ways.map((w) => [w.name, w.to.category, w.to.categoryOrigin.by])).toEqual([
      ["Move to Triage", "triage", "native"],
      ["Move to Backlog", "backlog", "mapping"],
      ["Move to Not now", "backlog", "native"],
      ["Move to Done", "done", "native"],
    ]);
    const notNow = await b.transitions!.apply!(meta(), r, ways[2].id, {});
    expect(notNow?.status).toMatchObject({ name: "Not now", category: "backlog" });
    const done = await b.transitions!.apply!(meta(), r, ways[3].id, {});
    expect(done?.status).toMatchObject({ name: "Done", category: "done" });
    expect(card.completed).toBe(true);
    sim.outside.moveToColumn(card, "Review");
    expect((await b.getIssue(meta(), r))?.status).toMatchObject({ name: "Open", category: "todo" });
    expect(await errorOf(b.transitions!.apply!(meta(), r, `column:${web.columns!.find((c) => c.title === "Review")!.id}`, {}))).toMatchObject({ kind: "invalid" });
    expect(await errorOf(b.transitions!.apply!(meta(), r, "complete", {}))).toMatchObject({ kind: "invalid" });
  });

  it("a column not named in the options means nothing, whatever its title", async () => {
    const { b, sim } = simulated({ options: { columns: { Review: "doing" } } });
    expect((await b.getIssue(meta(), ref(sim.recs[2])))?.status.name).toBe("Open");
    sim.outside.moveToColumn(sim.recs[2], "Review");
    expect((await b.getIssue(meta(), ref(sim.recs[2])))?.status).toMatchObject({ name: "Review", category: "doing" });
  });

  it("a column renamed on Basecamp keeps its id; the options match titles, so a renamed one needs the new name", async () => {
    const { b, sim, web } = simulated({ options: { columns: { Started: "doing" } } });
    const r = ref(sim.recs[2]);
    expect((await b.getIssue(meta(), r))?.status.name).toBe("Open");
    const id = String(web.columns!.find((c) => c.title === "Doing")!.id);
    sim.outside.renameColumn(web, "Doing", "Started");
    expect((await b.getIssue(meta(), r))?.status).toMatchObject({ id, name: "Started", category: "doing" });
  });

  it("every project with a card table is a board of the probe, with its columns as statuses in order", async () => {
    const { b } = simulated(COLUMNS);
    const probe = await b.probe(meta());
    expect(probe.activeSources.map((s) => [s.kind, s.name])).toEqual([
      ["boolean", "Open / completed"],
      ["column", "Website (card table)"],
    ]);
    expect(probe.rateLimit).toEqual({ perSecond: 5, origin: "typical" });
    expect((await b.statuses!(meta(), probe.activeSources[1])).map((s) => [s.name, s.category, s.order])).toEqual([
      ["Triage", "triage", 0],
      ["Backlog", "backlog", 1],
      ["Doing", "doing", 2],
      ["Not now", "backlog", 4],
      ["Done", "done", 5],
    ]);
  });
});

describe("basecamp, comments", () => {
  it("reads rich text and writes it as the few tags Basecamp keeps", async () => {
    const { b, sim } = simulated();
    const t = sim.recs[0];
    const r = ref(t);
    sim.outside.comment(t, "<div>Reproduced on <strong>iOS</strong> 18</div>");
    const added = await b.comments!.add!(meta(), r, markdown("Looks **fixed**, see [the fix](https://example.org/pr/1)"), { idempotencyKey: "c1" });
    expect(added.comment?.body).toEqual({ kind: "text", format: "html", text: '<div>Looks <strong>fixed</strong>, see <a href="https://example.org/pr/1">the fix</a></div>' });
    expect(added.warnings).toEqual([]);
    const list = await b.comments!.list(meta(), r);
    expect(list.map((c) => [c.author.name, c.body.kind === "text" ? c.body.text : ""])).toEqual([
      ["Anna Bianchi", "<div>Reproduced on <strong>iOS</strong> 18</div>"],
      ["Mario Rossi", '<div>Looks <strong>fixed</strong>, see <a href="https://example.org/pr/1">the fix</a></div>'],
    ]);
    expect(toRichDoc(list[0].body).blocks.length).toBeGreaterThan(0);
    // Comments live on the recording whatever its type.
    expect((await b.comments!.add!(meta(), ref(sim.recs[2]), markdown("on a card"), { idempotencyKey: "c2" })).comment).not.toBeNull();
  });

  it("Basecamp drops any tag outside its list, so Markdown is written without them, and what is lost is said", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.recs[0]);
    const direct = await raw(sim, `/buckets/${sim.recs[0].bucket}/recordings/${sim.recs[0].id}/comments.json`, { method: "POST", json: { content: "<p>hi <code>x</code></p><h2>t</h2>" } });
    expect(((await direct.json()) as { content: string }).content).toBe("hi xt");
    const md = "# Title\n## Sub\n\n- one\n- **two**\n\n1. a\n2. b\n\n> quoted\n\n```\ncode & <b>\n```\n\nuse `x` ~~old~~\nsecond line\n\n| a | b |\n|---|---|\n\n![img](https://example.org/i.png)";
    const added = await b.comments!.add!(meta(), r, markdown(md), { idempotencyKey: "c3" });
    expect(added.warnings.map((w) => w.feature).sort()).toEqual(["code", "heading", "image", "table"]);
    expect(added.comment?.body.kind === "text" && added.comment.body.text).toBe(
      '<h1>Title</h1><h1>Sub</h1><ul><li>one</li><li><strong>two</strong></li></ul><ol><li>a</li><li>b</li></ol><blockquote><div>quoted</div></blockquote><pre>code &amp; &lt;b&gt;</pre><div>use x <strike>old</strike><br>second line</div><div>| a | b |<br>|---|---|</div><div><a href="https://example.org/i.png">img</a></div>',
    );
    expect(toBasecampHtml("a & b < c *x*").html).toBe("<div>a &amp; b &lt; c <em>x</em></div>");
  });
});

describe("basecamp, watching and history", () => {
  it("subscribing twice and unsubscribing twice are successes", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.recs[0]);
    await b.watch!(meta(), r, true);
    await b.watch!(meta(), r, true);
    expect(sim.recs[0].subscribers.has(sim.me.id)).toBe(true);
    await b.watch!(meta(), r, false);
    await b.watch!(meta(), r, false);
    expect(sim.recs[0].subscribers.has(sim.me.id)).toBe(false);
  });

  it("history turns events into changes in time order, people by name; events it does not know stay as they are", async () => {
    const { b, sim } = simulated();
    const t = sim.recs[0];
    sim.outside.complete(t);
    sim.outside.reopen(t);
    sim.outside.assign(t, [sim.anna.id]);
    sim.outside.retitle(t, "Renamed");
    sim.outside.due(t, "2026-12-01");
    const h = await b.history!(meta(), ref(t));
    expect(h.map((c) => [c.field.id ?? c.field.name, c.from.map((v) => v.text), c.to.map((v) => v.text)])).toEqual([
      ["completed", ["No"], ["Yes"]],
      ["completed", ["Yes"], ["No"]],
      ["assignees", ["Mario Rossi"], ["Anna Bianchi"]],
      ["content", [], []],
      ["due_on_changed", [], []],
    ]);
    expect(h[0].actor).toMatchObject({ name: "Anna Bianchi" });
    expect(h.map((c) => c.at)).toEqual([...h.map((c) => c.at)].sort((a, c) => a - c));
  });
});

describe("basecamp, time", () => {
  const date = (d: string) => ({ kind: "date" as const, date: localDate(d), seconds: 0 });
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it("logs a day's time in minutes, written as H:MM and read back from hours with two decimals, rounded to the minute", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.recs[0]);
    // 5430 s is 90.5 minutes: 91 are kept; 91 minutes is 1.52 hours, which reads back as 91 minutes.
    const made = await b.worklogs!.create!(meta(), r, { time: { ...date("2026-10-14"), seconds: 5430 }, comment: "debugging" }, { idempotencyKey: "k1" });
    expect(sim.entries[0].minutes).toBe(91);
    expect(made).toMatchObject({ span: { kind: "date", date: "2026-10-14", seconds: 91 * 60 }, comment: "debugging", billable: null, approval: null, editable: { update: true, delete: true }, issue: { remoteId: String(sim.recs[0].id), key: sim.keyOf(sim.recs[0]) } });
    // 20 minutes is 0.33 hours on the wire: 19.8 minutes, so 20.
    const third = await b.worklogs!.create!(meta(), r, { time: { ...date("2026-10-14"), seconds: 1200 }, comment: "" }, { idempotencyKey: "k2" });
    expect(((await (await raw(sim, `/buckets/${sim.recs[0].bucket}/timesheet/entries/${third.remoteId}.json`)).json()) as { hours: string }).hours).toBe("0.33");
    expect(third.span.seconds).toBe(1200);
    const tiny = await b.worklogs!.create!(meta(), r, { time: { ...date("2026-10-14"), seconds: 10 }, comment: "" }, { idempotencyKey: "k3" });
    expect(tiny.span.seconds).toBe(60);
    const changed = await b.worklogs!.update!(meta(), r, made.remoteId, { time: { ...date("2026-10-15"), seconds: 1800 }, comment: "changed" }, {});
    expect(changed).toMatchObject({ span: { date: "2026-10-15", seconds: 1800 }, comment: "changed" });
    expect((await b.worklogs!.list(meta(), r)).map((w) => w.remoteId).sort()).toEqual([made.remoteId, third.remoteId, tiny.remoteId].sort());
    expect((await b.worklogs!.get!(meta(), r, made.remoteId))?.comment).toBe("changed");
    // Without the project in the ref, the key says where it is.
    expect((await b.worklogs!.get!(meta(), { remoteId: r.remoteId, key: r.key }, made.remoteId))?.comment).toBe("changed");
  });

  it("an entry deleted is trashed: it leaves the lists, is answered no more, and deleting twice is a success", async () => {
    const { b, sim } = simulated();
    const t = sim.recs[0];
    const r = ref(t);
    const e = sim.entry(t, { minutes: 30, date: daysAgo(2) });
    await b.worklogs!.delete!(meta(), r, String(e.id), {});
    expect(e.status).toBe("trashed");
    await b.worklogs!.delete!(meta(), r, String(e.id), {});
    expect((await raw(sim, `/buckets/${t.bucket}/timesheet/entries/${e.id}.json`)).status).toBe(200);
    expect(await b.worklogs!.get!(meta(), r, String(e.id))).toBeNull();
    expect((await b.worklogs!.list(meta(), r)).map((w) => w.remoteId)).not.toContain(String(e.id));
    await b.worklogs!.delete!(meta(), r, "999", {});
  });

  it("an entry of someone else is read, never editable; changing it is forbidden", async () => {
    const { b, sim } = simulated();
    const t = sim.recs[0];
    const r = ref(t);
    const theirs = sim.entry(t, { minutes: 15, date: daysAgo(1), person: sim.anna.id });
    const list = await b.worklogs!.list(meta(), r);
    expect(list.find((w) => w.remoteId === String(theirs.id))).toMatchObject({ authorRemoteId: String(sim.anna.id), editable: { update: false, delete: false } });
    expect(await errorOf(b.worklogs!.update!(meta(), r, String(theirs.id), { time: { ...date(daysAgo(1)), seconds: 600 }, comment: "x" }, {}))).toMatchObject({ kind: "forbidden" });
    expect(await errorOf(b.worklogs!.delete!(meta(), r, String(theirs.id), {}))).toMatchObject({ kind: "forbidden" });
  });

  it("logs on behalf of someone, and refuses a session: Basecamp keeps a day", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.recs[0]);
    const made = await b.worklogs!.create!(meta(), r, { time: { ...date(daysAgo(1)), seconds: 600 }, comment: "for Anna", onBehalfOfRemoteId: String(sim.anna.id) }, { idempotencyKey: "k" });
    expect(made.authorRemoteId).toBe(String(sim.anna.id));
    expect(sim.entries[0].person).toBe(sim.anna.id);
    const err = await errorOf(b.worklogs!.create!(meta(), r, { time: { kind: "session", start: instant(Date.UTC(2026, 9, 14, 8)), seconds: 600 }, comment: "" }, { idempotencyKey: "k" }));
    expect(err).toMatchObject({ kind: "invalid" });
    expect(await errorOf(b.worklogs!.create!(meta(), r, { time: { ...date(daysAgo(1)), seconds: 600 }, comment: "", onBehalfOfRemoteId: "42" }, { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid" });
  });

  it("the feed is a window of days: the user's entries of the last month, in a report paged by 15, with nothing trashed, nothing of others, nothing logged on no to-do", async () => {
    const { b, sim, web } = simulated();
    const t = sim.recs[0];
    const other = sim.recs[1];
    for (let n = 0; n < 20; n++) sim.entry(n % 2 ? t : other, { minutes: 10 + n, date: daysAgo(n % 25) });
    const old = sim.entry(t, { minutes: 5, date: daysAgo(40) });
    const trashed = sim.entry(t, { minutes: 6, date: daysAgo(3) });
    sim.outside.trashEntry(trashed);
    const theirs = sim.entry(t, { minutes: 7, date: daysAgo(3), person: sim.anna.id });
    const message = sim.add("A message", { project: web, kind: "Message" });
    const onMessage = sim.entry(message, { minutes: 8, date: daysAgo(3) });
    const feed = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    expect(feed.pages).toBe(2);
    expect(feed.items.length).toBe(20);
    const ids = feed.items.map((w) => w.remoteId);
    for (const e of [old, trashed, theirs, onMessage]) expect(ids).not.toContain(String(e.id));
    expect(feed.items.every((w) => w.issue?.key?.startsWith("BC-"))).toBe(true);
    // The window is read whole again at each pass, whatever the checkpoint.
    expect((await readPass((q) => b.worklogs!.changed!(meta(), q), feed.checkpoint)).items.length).toBe(20);
    expect(b.capabilities.time).toMatchObject({ entries: { feed: { kind: "window", by: "entryDate", days: 30, overlapDays: 2 } } });
  });

  it("an entry that is not a valid duration or day is refused by Basecamp (422), as invalid", async () => {
    const { sim } = simulated();
    const t = sim.recs[0];
    const path = `/buckets/${t.bucket}/recordings/${t.id}/timesheet/entries.json`;
    expect((await raw(sim, path, { method: "POST", json: { date: "2026-10-14", hours: "abc" } })).status).toBe(422);
    expect((await raw(sim, path, { method: "POST", json: { date: "14/10/2026", hours: "1:00" } })).status).toBe(422);
    expect((await raw(sim, path, { method: "POST", json: { date: "2026-10-14", hours: "1.5" } })).status).toBe(201);
    expect((await raw(sim, path, { method: "POST", json: { date: "2026-10-14", hours: "1:20" } })).status).toBe(201);
    expect(sim.entries.map((e) => e.minutes)).toEqual([90, 80]);
  });
});

describe("basecamp, webhooks", () => {
  it("accepts a Basecamp payload and refuses anything else (no signature: the secret in the URL is the core's)", () => {
    const { sim } = simulated();
    const d = sim.webhook("todo_completed", sim.recs[0]);
    expect(basecampProvider.webhook!.verify({ headers: d.headers, body: d.rawBody }, "s")).toBe(true);
    expect(basecampProvider.webhook!.verify({ headers: {}, body: "not json" }, "s")).toBe(false);
    expect(basecampProvider.webhook!.verify({ headers: {}, body: "[]" }, "s")).toBe(false);
    expect(basecampProvider.webhook!.verify({ headers: {}, body: JSON.stringify({ kind: "x" }) }, "s")).toBe(false);
    expect(basecampProvider.webhook!.verify({ headers: {}, body: JSON.stringify({ recording: {} }) }, "s")).toBe(false);
  });

  it("gives the delivery's own id to refuse a replay by, and its time to refuse a stale one by", () => {
    const { sim } = simulated();
    const d = sim.webhook("todo_completed", sim.recs[0], { ageMs: 5000, deliveryId: 4242 });
    expect(basecampProvider.webhook!.deliveryId({ headers: d.headers, body: d.rawBody })).toBe("4242");
    const at = basecampProvider.webhook!.sentAt!({ headers: d.headers, body: d.rawBody })!;
    expect(Date.now() - at).toBeGreaterThanOrEqual(5000);
    expect(Date.now() - at).toBeLessThan(60_000);
    expect(basecampProvider.webhook!.deliveryId({ headers: {}, body: "nope" })).toBeNull();
    expect(basecampProvider.webhook!.sentAt!({ headers: {}, body: "{}" })).toBeNull();
  });

  it("names the declared events a delivery is", () => {
    const { sim } = simulated();
    expect(basecampWebhook.events(sim.webhook("todo_completed", sim.recs[0]).rawBody)).toEqual(["issueChanged"]);
    expect(basecampWebhook.events(sim.webhook("kanban_card_moved", sim.recs[2]).rawBody)).toEqual(["issueChanged"]);
    expect(basecampWebhook.events(sim.webhook("comment_created", sim.recs[0]).rawBody)).toEqual(["commentAdded"]);
    const message = sim.add("A message", { project: sim.projects.values().next().value!, kind: "Message" });
    expect(basecampWebhook.events(sim.webhook("message_created", message).rawBody)).toEqual([]);
    expect(basecampWebhook.events("nope")).toEqual([]);
  });
});

describe("basecamp, errors and limits", () => {
  it("a bad token is auth (401), on the launchpad too", async () => {
    const { b } = simulated({ token: "wrong" });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "auth" });
  });

  it("a revoked token is auth on every call", async () => {
    const { b, sim } = simulated();
    expect((await b.verify(meta())).remoteId).toBe(String(sim.me.id));
    sim.revoke();
    expect(await errorOf(pass(b))).toMatchObject({ kind: "auth" });
  });

  it("an exhausted quota is a wait: 429 with Retry-After in seconds", async () => {
    const { b, sim } = simulated();
    sim.exhaust();
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 10_000, remaining: 0 } });
    sim.refill();
    expect((await b.verify(meta())).name).toBe("Mario Rossi");
  });

  it("a missing recording is notFound where an operation needs it, null where a lookup asks", async () => {
    const { b, sim, web } = simulated();
    const ghost = { remoteId: "9999999", key: `BC-${web.id}-9999999` };
    expect(await b.getIssue(meta(), ghost)).toBeNull();
    expect(await errorOf(b.transitions!.list!(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.comments!.list(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.history!(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await b.getIssue(meta(), { remoteId: String(sim.recs[0].id), key: "nonsense" })).toBeNull();
  });

  it("knows who the token belongs to", async () => {
    const { b, sim } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: String(sim.me.id), name: "Mario Rossi", email: "mario@acme.example" });
  });
});
