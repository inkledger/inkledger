import { describe, expect, it, vi } from "vitest";
import { instant, localDate, markdown, timeZone } from "@contracts/values";
import { toRichDoc } from "../core/richtext";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import { wrikeSimulator, type SimTask } from "./simulator";
import { toWrikeHtml, wrikeProvider, wrikeWebhook } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "198.51.100.7", family: 4 }]),
}));

const DAY = 86_400_000;

function simulated(o: { token?: string; zone?: string } = {}) {
  const sim = wrikeSimulator();
  const web = sim.folder("Website", { project: true });
  sim.add("Login fails on Safari", { folder: web, description: "<p>Steps</p>", dueAt: "2026-11-05T17:00:00", importance: "High" });
  sim.add("Export to CSV", { folder: web, status: "In Progress" });
  sim.add("Rate limit headers");
  // Someone else's, and one I wrote for someone else: not assigned to me.
  sim.add("Anna's", { folder: web, responsible: [sim.anna.id] });
  sim.add("Delegated", { folder: web, responsible: [sim.anna.id], author: sim.me.id });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 9,
    userId: 1,
    type: "wrike" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: sim.me.id,
    options: {},
    timeZone: timeZone(o.zone ?? "Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, web, conn, b: bindTracker(wrikeProvider, conn) };
}

trackerConformance("wrike (simulated)", async () => {
  const { conn, sim } = simulated();
  return { provider: wrikeProvider, conn, key: sim.keyOf(sim.tasks[0]), writable: true, url: sim.permalinkOf(sim.tasks[0]) };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const pass = (b: ReturnType<typeof simulated>["b"], since: Parameters<typeof b.listChanged>[1]["since"] = null) => readPass((q) => b.listChanged(meta(), q), since);
const ref = (t: SimTask) => ({ remoteId: t.id, key: `WRIKE-${t.num}` });
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; rateLimit?: { retryAfterMs?: number; remaining?: number }; message: string });
const raw = (sim: ReturnType<typeof wrikeSimulator>, path: string, init: { method?: string; form?: Record<string, string> } = {}) =>
  sim.fetch(`${sim.apiBase}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `bearer ${sim.token}` },
    ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
  });
const jsonOf = async (r: Response) => (await r.json()) as { kind: string; data: Record<string, unknown>[]; nextPageToken?: string; error?: string };

describe("wrike, tasks", () => {
  it("lists what the user is responsible for; the key is the permalink's number, the remote id is the API id", async () => {
    const { b, sim } = simulated();
    const all = await pass(b);
    expect(all.items.map((i) => [i.key, i.title, i.status.name, i.status.category, i.container.kind, i.container.name])).toEqual([
      [`WRIKE-${sim.tasks[0].num}`, "Login fails on Safari", "New", "todo", "project", "Website"],
      [`WRIKE-${sim.tasks[1].num}`, "Export to CSV", "In Progress", "doing", "project", "Website"],
      [`WRIKE-${sim.tasks[2].num}`, "Rate limit headers", "New", "todo", "workspace", "No folder"],
    ]);
    const [first] = all.items;
    expect(first).toMatchObject({ remoteId: sim.tasks[0].id, url: sim.permalinkOf(sim.tasks[0]), due: "2026-11-05", priority: { name: "High", rank: 0 }, type: { id: "task", level: "standard" } });
    expect(first.remoteId).toMatch(/^[A-Z0-9]{16}$/);
    expect(first.key).not.toContain(first.remoteId);
    expect(first.assignees[0]).toMatchObject({ remoteId: sim.me.id, name: "Mario Rossi", avatarUrl: "https://www.wrike.com/avatars/mario.png" });
    expect(first.reporter).toMatchObject({ name: "Mario Rossi" });
    expect(await b.description!(meta(), ref(sim.tasks[0]))).toEqual({ kind: "text", format: "html", text: "<p>Steps</p>" });
    expect(await b.description!(meta(), ref(sim.tasks[1]))).toBeNull();
  });

  it("Wrike answers a task with its default fields only, and every answer is a list, even for one record", async () => {
    const { sim } = simulated();
    const bare = await jsonOf(await raw(sim, `/tasks/${sim.tasks[0].id}`));
    expect(bare.kind).toBe("tasks");
    expect(bare.data).toHaveLength(1);
    expect(Object.keys(bare.data[0])).not.toContain("description");
    expect(Object.keys(bare.data[0])).not.toContain("responsibleIds");
    const asked = await jsonOf(await raw(sim, `/tasks/${sim.tasks[0].id}?fields=${encodeURIComponent('["responsibleIds","description"]')}`));
    expect(asked.data[0]).toMatchObject({ responsibleIds: [sim.me.id], description: "<p>Steps</p>" });
  });

  it("a task shared with others lists every responsible; one only others have is not the user's", async () => {
    const { sim, b } = simulated();
    const shared = sim.add("Pair work", { responsible: [sim.me.id, sim.anna.id] });
    const all = await pass(b);
    expect(all.items.find((i) => i.remoteId === shared.id)?.assignees.map((a) => a.name)).toEqual(["Mario Rossi", "Anna Bianchi"]);
    expect(all.items.map((i) => i.title)).not.toContain("Anna's");
  });

  it("reads a pass page by page (a hundred a page, a token), then only what changed since its checkpoint", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 120; n++) sim.add(`Bulk ${n}`);
    const all = await pass(b);
    expect(all.pages).toBeGreaterThanOrEqual(3);
    expect(all.items.length).toBe(123);
    expect(new Set(all.items.map((i) => i.remoteId)).size).toBe(123);
    expect((await pass(b, all.checkpoint)).items).toEqual([]);
    sim.outside.retitle(sim.tasks[0], "Login fails on Safari 18");
    const again = await pass(b, all.checkpoint);
    expect(again.items.map((i) => i.title)).toEqual(["Login fails on Safari 18"]);
  });

  it("a page size is needed for a token (without it Wrike gives the first thousand and no token), and is at most 1000", async () => {
    const { sim } = simulated();
    for (let n = 0; n < 30; n++) sim.add(`Bulk ${n}`);
    const noSize = await jsonOf(await raw(sim, `/tasks?responsibles=${encodeURIComponent(`["${sim.me.id}"]`)}`));
    expect(noSize.nextPageToken).toBeUndefined();
    expect(noSize.data.length).toBe(33);
    const sized = await jsonOf(await raw(sim, `/tasks?pageSize=10`));
    expect(sized.nextPageToken).toBeTruthy();
    expect((await raw(sim, "/tasks?pageSize=1001")).status).toBe(400);
  });

  it("a page token Wrike no longer takes is an invalid checkpoint, so the pass is read again", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 120; n++) sim.add(`Bulk ${n}`);
    const first = await b.listChanged(meta(), { since: null, page: null });
    expect(first.last).toBe(false);
    sim.expireTokens();
    if (!first.last) expect(await errorOf(b.listChanged(meta(), { since: null, page: first.next }))).toMatchObject({ kind: "invalidCheckpoint" });
    expect((await pass(b)).items.length).toBe(123);
  });

  it("filter dates are UTC to the second: milliseconds are refused by Wrike, and the adapter never sends them", async () => {
    const { b, sim } = simulated();
    const ms = `/tasks?updatedDate=${encodeURIComponent(JSON.stringify({ start: new Date().toISOString() }))}`;
    expect((await raw(sim, ms)).status).toBe(400);
    const first = await pass(b);
    sim.outside.retitle(sim.tasks[1], "Export to TSV");
    expect((await pass(b, first.checkpoint)).items.map((i) => i.title)).toEqual(["Export to TSV"]);
  });

  it("a first read keeps active and deferred tasks and those finished lately; a later one every task touched since", async () => {
    const { b, sim } = simulated();
    const old = sim.add("Done long ago", { status: "Completed" });
    old.updated = Date.now() - 90 * DAY;
    const parked = sim.add("Parked", { status: "On Hold" });
    parked.updated = Date.now() - 90 * DAY;
    const recent = sim.add("Done this week");
    sim.outside.setStatus(recent, "Completed");
    const first = await pass(b);
    const titles = first.items.map((i) => i.title);
    expect(titles).toContain("Done this week");
    expect(titles).toContain("Parked");
    expect(titles).not.toContain("Done long ago");
    expect(first.items.find((i) => i.title === "Done this week")?.status).toMatchObject({ name: "Completed", category: "done" });
    expect(first.items.find((i) => i.title === "Parked")?.status).toMatchObject({ category: "backlog" });
    expect(first.items.find((i) => i.title === "Done this week")?.statusChangedAt).not.toBeNull();
    sim.outside.comment(old, "still relevant");
    const later = (await pass(b, first.checkpoint)).items.map((i) => i.title);
    expect(later).toContain("Done long ago");
    expect(later).not.toContain("Rate limit headers");
  });

  it("task dates are floating local times, the day they say; one with a zone is an instant on the user's day", async () => {
    const { sim, b } = simulated();
    const late = sim.add("Late", { dueAt: "2026-11-05T23:30:00" });
    expect((await b.getIssue(meta(), ref(late)))?.due).toBe("2026-11-05");
    const z = sim.add("Zoned", { dueAt: "2026-11-05T23:30:00Z" });
    expect((await b.getIssue(meta(), ref(z)))?.due).toBe("2026-11-06");
    expect((await b.getIssue(meta(), ref(sim.tasks[2])))?.due).toBeNull();
    const la = simulated({ zone: "America/Los_Angeles" });
    const t = la.sim.add("Late", { dueAt: "2026-11-05T23:30:00" });
    expect((await la.b.getIssue(meta(), ref(t)))?.due).toBe("2026-11-05");
  });

  it("a milestone and a subtask are told apart; effort comes in minutes", async () => {
    const { sim, b } = simulated();
    const ms = sim.add("Launch", { milestone: true, dueAt: "2026-12-01T09:00:00" });
    const sub = sim.add("Check Safari 17", { folder: sim.tasks[0].parentIds.map((id) => sim.folders.get(id)!), parent: sim.tasks[0], effort: 90 });
    expect((await b.getIssue(meta(), ref(ms)))?.type).toMatchObject({ id: "milestone" });
    const got = await b.getIssue(meta(), ref(sub));
    expect(got).toMatchObject({ type: { id: "subtask", level: "sub" }, estimateSeconds: 5400, container: { name: "Website" } });
  });

  it("a task in several folders has the first as its container; one in none sits in the account; a moved or renamed folder keeps ids", async () => {
    const { sim, b, web } = simulated();
    const other = sim.folder("Marketing");
    const t = sim.tasks[0];
    t.parentIds = [web.id, other.id];
    expect((await b.getIssue(meta(), ref(t)))?.container).toMatchObject({ remoteId: web.id, name: "Website", kind: "project" });
    const first = await pass(b);
    const archive = sim.folder("Archive");
    sim.outside.moveToFolders(t, [archive]);
    sim.outside.renameFolder(archive, "Archive 2026");
    const next = await pass(b, first.checkpoint);
    expect(next.items.map((i) => [i.remoteId, i.key, i.container.name, i.container.remoteId, i.container.kind])).toEqual([[t.id, `WRIKE-${t.num}`, "Archive 2026", archive.id, "folder"]]);
    expect((await b.getIssue(meta(), ref(sim.tasks[2])))?.container).toMatchObject({ kind: "workspace" });
  });

  it("a task in the recycle bin still answers by id (scope RbTask) but reads as gone; the next pass says it was deleted", async () => {
    const { sim, b } = simulated();
    const first = await pass(b);
    const t = sim.tasks[1];
    sim.outside.delete(t);
    const direct = await jsonOf(await raw(sim, `/tasks/${t.id}`));
    expect(direct.data[0]).toMatchObject({ id: t.id, scope: "RbTask" });
    expect(await b.getIssue(meta(), ref(t))).toBeNull();
    expect((await b.findIssue(meta(), { key: `WRIKE-${t.num}` })).kind).toBe("none");
    expect((await pass(b)).items.map((i) => i.title)).not.toContain("Export to CSV");
    const next = await pass(b, first.checkpoint);
    expect(next.gone).toEqual([{ remoteId: t.id, reason: "deleted" }]);
    expect(next.items).toEqual([]);
    sim.outside.restore(t);
    expect((await b.getIssue(meta(), ref(t)))?.title).toBe("Export to CSV");
  });

  it("what the user cannot see is a 403, read as not there", async () => {
    const { sim, b, web } = simulated();
    const hidden = sim.tasks[0];
    hidden.responsibleIds = [sim.anna.id];
    sim.outside.access(web, false);
    expect((await raw(sim, `/tasks/${hidden.id}`)).status).toBe(403);
    expect(await b.getIssue(meta(), ref(hidden))).toBeNull();
    expect((await b.findIssue(meta(), { key: `WRIKE-${hidden.num}` })).kind).toBe("none");
  });

  it("a person Wrike no longer gives back is kept by id", async () => {
    const { sim, b } = simulated();
    const ghost = sim.addUser("Gone", "Away");
    const t = sim.add("Orphaned", { responsible: [sim.me.id, ghost.id] });
    sim.outside.deleteUser(ghost.id);
    expect((await b.getIssue(meta(), ref(t)))?.assignees.map((a) => a.name)).toEqual(["Mario Rossi", ghost.id]);
  });

  it("searches the user's tasks by title (a substring, other people's left out), cut at the limit", async () => {
    const { b } = simulated();
    const r = await b.searchText!(meta(), "export", 10);
    expect(r.items.map((i) => i.title)).toEqual(["Export to CSV"]);
    expect(r.complete).toBe(true);
    const cut = await b.searchText!(meta(), "a", 1);
    expect(cut.items.length).toBe(1);
    expect(cut.complete).toBe(false);
    const f = await b.searchText!(meta(), "a", 10);
    expect(f.items.map((i) => i.title)).not.toContain("Anna's");
  });
});

describe("wrike, keys and links", () => {
  it("reads keys and the links of a task (open.htm?id=<n>), nothing else", () => {
    const { b } = simulated();
    expect(b.normalizeKey("wrike-4000100007")).toBe("WRIKE-4000100007");
    expect(b.normalizeKey("4000100007")).toBeNull();
    expect(b.normalizeKey("WRIKE-x")).toBeNull();
    expect(b.parseRef("https://www.wrike.com/open.htm?id=4000100007")).toEqual({ key: "WRIKE-4000100007" });
    expect(b.parseRef("https://www.wrike.com/open.htm?id=4000100007&x=1")).toEqual({ key: "WRIKE-4000100007" });
    expect(b.parseRef("https://www.wrike.com/open.htm?id=IEAAJKV3KQAAAAAA")).toBeNull();
    expect(b.parseRef("https://www.wrike.com/workspace.htm#/folder/1")).toBeNull();
    expect(b.parseRef("https://wrike.example/open.htm?id=1")).toBeNull();
  });

  it("converts the permalink's number to the API id (GET /ids), which are two different ids; an unknown number is none", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[2];
    const ids = await jsonOf(await raw(sim, `/ids?type=ApiV2Task&ids=${encodeURIComponent(`[${t.num},999]`)}`));
    expect(ids.data).toEqual([{ id: t.id, uid: t.num }]);
    const found = await b.findIssue(meta(), { key: `WRIKE-${t.num}` });
    expect(found.kind === "found" && found.issue.remoteId).toBe(t.id);
    expect(String(t.num)).not.toBe(t.id);
    expect((await b.findIssue(meta(), { key: "WRIKE-999" })).kind).toBe("none");
    expect((await raw(sim, "/tasks/12345")).status).toBe(400);
  });

  it("finds a task by a pasted link", async () => {
    const { b, sim } = simulated();
    const handle = b.parseRef(sim.permalinkOf(sim.tasks[2]));
    const found = handle && (await b.findIssue(meta(), handle));
    expect(found && found.kind === "found" && found.issue.title).toBe("Rate limit headers");
  });
});

describe("wrike, workflow", () => {
  it("offers the other statuses of the task's workflow (hidden ones left out), with Wrike's group as the category", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.tasks[0]);
    const ways = await b.transitions!.list!(meta(), r);
    expect(ways.map((w) => [w.name, w.to.category, w.to.categoryOrigin.by])).toEqual([
      ["Move to In Progress", "doing", "native"],
      ["Move to On Hold", "backlog", "native"],
      ["Move to Completed", "done", "native"],
      ["Move to Cancelled", "cancelled", "native"],
    ]);
    const done = await b.transitions!.apply!(meta(), r, ways[2].id, {});
    expect(done?.status).toMatchObject({ name: "Completed", category: "done" });
    expect(done?.statusChangedAt).not.toBeNull();
    expect((await b.transitions!.list!(meta(), r)).map((w) => w.to.name)).toEqual(["New", "In Progress", "On Hold", "Cancelled"]);
    const back = await b.transitions!.apply!(meta(), r, (await b.transitions!.list!(meta(), r))[0].id, {});
    expect(back?.status).toMatchObject({ name: "New", category: "todo" });
    expect((await b.probe(meta())).activeSources.map((s) => s.kind)).toEqual(["itemState"]);
  });

  it("a folder can have its own workflow: its statuses, its first active one is todo; a status of another workflow is refused", async () => {
    const { b, sim } = simulated();
    const design = sim.addWorkflow("Design", [
      ["Brief", "Active"],
      ["Mockup", "Active"],
      ["Parked", "Deferred"],
      ["Shipped", "Completed"],
    ]);
    const studio = sim.folder("Studio", { workflow: design });
    const t = sim.add("Logo", { folder: studio });
    const got = await b.getIssue(meta(), ref(t));
    expect(got?.status).toMatchObject({ name: "Brief", category: "todo" });
    const ways = await b.transitions!.list!(meta(), ref(t));
    expect(ways.map((w) => [w.to.name, w.to.category])).toEqual([
      ["Mockup", "doing"],
      ["Parked", "backlog"],
      ["Shipped", "done"],
    ]);
    const foreign = sim.statusNamed(sim.standard, "In Progress");
    expect(await errorOf(b.transitions!.apply!(meta(), ref(t), foreign.id, {}))).toMatchObject({ kind: "invalid" });
    expect((await raw(sim, `/tasks/${t.id}`, { method: "PUT", form: { customStatus: foreign.id } })).status).toBe(400);
    const all = await b.statuses!(meta(), { kind: "itemState", transitions: "direct", ref: { kind: "itemState" }, name: "Task status" });
    expect(all.map((s) => s.name)).toEqual(["New", "In Progress", "On Hold", "Completed", "Cancelled", "Brief", "Mockup", "Parked", "Shipped"]);
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
  });

  it("a hidden status can't be set, whatever the id says", async () => {
    const { b, sim } = simulated();
    const hidden = sim.statusNamed(sim.standard, "Old stage");
    expect((await raw(sim, `/tasks/${sim.tasks[0].id}`, { method: "PUT", form: { customStatus: hidden.id } })).status).toBe(400);
    expect(await errorOf(b.transitions!.apply!(meta(), ref(sim.tasks[0]), hidden.id, {}))).toMatchObject({ kind: "invalid" });
    // A task already in a hidden status reads it, with the group's meaning.
    sim.tasks[1].status = hidden;
    expect((await b.getIssue(meta(), ref(sim.tasks[1])))?.status).toMatchObject({ name: "Old stage", category: "doing" });
  });

  it("a task whose custom status Wrike no longer lists reads as its group", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[1];
    sim.standard.statuses = sim.standard.statuses.filter((s) => s.id !== t.status.id);
    const got = await b.getIssue(meta(), ref(t));
    expect(got?.status).toMatchObject({ name: "Active", category: "todo", categoryOrigin: { by: "native" } });
    expect(await b.transitions!.list!(meta(), ref(t))).toEqual([]);
  });

  it("refuses options it can't read", () => {
    expect(() => wrikeProvider.parseOptions({ workspace: "x" })).toThrow();
    expect(wrikeProvider.parseOptions(undefined)).toEqual({});
  });
});

describe("wrike, comments", () => {
  it("reads HTML comments with their authors and writes Markdown as the few tags Wrike keeps", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const r = ref(t);
    sim.outside.comment(t, "Reproduced on <b>iOS</b> 18");
    const added = await b.comments!.add!(meta(), r, markdown("Looks **fixed**, see [the fix](https://example.org/pr/1)\nsecond line\n\n- a\n- b"), { idempotencyKey: "c1" });
    expect(added.comment?.body).toEqual({ kind: "text", format: "html", text: 'Looks <b>fixed</b>, see <a href="https://example.org/pr/1">the fix</a><br />second line<br /><ul><li>a</li><li>b</li></ul>' });
    expect(added.warnings).toEqual([]);
    const list = await b.comments!.list(meta(), r);
    expect(list.map((c) => [c.author.name, c.body.kind === "text" ? c.body.text : ""]).slice(0, 1)).toEqual([["Anna Bianchi", "Reproduced on <b>iOS</b> 18"]]);
    expect(list[1].author.name).toBe("Mario Rossi");
    expect(toRichDoc(list[0].body).blocks.length).toBeGreaterThan(0);
  });

  it("Wrike strips the tags it doesn't keep without a word, so none is sent; a newline is not a break; what is lost is said", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.tasks[0]);
    const direct = await jsonOf(await raw(sim, `/tasks/${sim.tasks[0].id}/comments`, { method: "POST", form: { text: "<h1>Title</h1><p>hi</p>", plainText: "false" } }));
    expect(direct.data[0].text).toBe("Titlehi");
    const md = "# Title\n\n> quoted\n\n```\ncode & <b>\n```\n\n| a | b |\n|---|---|\n\n![img](https://example.org/i.png)";
    const added = await b.comments!.add!(meta(), r, markdown(md), { idempotencyKey: "c2" });
    expect(added.warnings.map((w) => w.feature).sort()).toEqual(["codeBlock", "heading", "image", "quote", "table"]);
    expect(added.comment?.body.kind === "text" && added.comment.body.text).not.toMatch(/<(p|h1|blockquote|pre)\b/);
    expect(toWrikeHtml("one\ntwo").html).toBe("one<br />two");
    expect(toWrikeHtml("one\n\ntwo").html).toBe("one<br /><br />two");
    expect(toWrikeHtml("a & b < c *x* `y*z*` ~~s~~").html).toBe("a &amp; b &lt; c <i>x</i> <code>y*z*</code> <strike>s</strike>");
    expect(toWrikeHtml("1. a\n2. b\n\ntext").html).toBe("<ol><li>a</li><li>b</li></ol><br />text");
  });
});

describe("wrike, watching", () => {
  it("following twice and unfollowing twice are successes", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.tasks[0]);
    await b.watch!(meta(), r, true);
    await b.watch!(meta(), r, true);
    expect(sim.tasks[0].followerIds.has(sim.me.id)).toBe(true);
    await b.watch!(meta(), r, false);
    await b.watch!(meta(), r, false);
    expect(sim.tasks[0].followerIds.has(sim.me.id)).toBe(false);
  });
});

describe("wrike, time", () => {
  const date = (d: string) => ({ kind: "date" as const, date: localDate(d), seconds: 0 });

  it("logs a day's time in decimal hours kept to two decimals (rounded to 36 s, at least one step), billable and with a category", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.tasks[0]);
    const cat = sim.category("Design");
    const made = await b.worklogs!.create!(meta(), r, { time: { ...date("2026-10-14"), seconds: 5430 }, comment: "debugging", billable: true, activityId: cat.id }, { idempotencyKey: "k1" });
    // 5430 s is 1.5083 h: 1.51 h are kept, which is 5436 s.
    expect(sim.timelogs.find((l) => l.id === made.remoteId)?.hours).toBe(1.51);
    expect(made).toMatchObject({ span: { kind: "date", date: "2026-10-14", seconds: 5436 }, comment: "debugging", billable: true, activity: { id: cat.id, name: "Design" }, approval: "draft", editable: { update: true, delete: true }, issue: { remoteId: sim.tasks[0].id } });
    const tiny = await b.worklogs!.create!(meta(), r, { time: { ...date("2026-10-14"), seconds: 10 }, comment: "" }, { idempotencyKey: "k2" });
    expect(tiny.span.seconds).toBe(36);
    expect(tiny.billable).toBe(false);
    const changed = await b.worklogs!.update!(meta(), r, made.remoteId, { time: { ...date("2026-10-15"), seconds: 1800 }, comment: "changed", billable: false }, {});
    expect(changed).toMatchObject({ span: { date: "2026-10-15", seconds: 1800 }, billable: false, comment: "changed", activity: { id: cat.id } });
    expect((await b.worklogs!.list(meta(), r)).map((w) => w.remoteId).sort()).toEqual([made.remoteId, tiny.remoteId].sort());
    expect((await b.worklogs!.get!(meta(), r, made.remoteId))?.comment).toBe("changed");
    expect(b.capabilities.time).toMatchObject({ entries: { feed: { kind: "window", by: "updatedAt" }, reconcile: { kind: "period" } } });
  });

  it("the tracked day and the creation instant are two things: the day is kept as given, whatever the clock says", async () => {
    const { b, sim } = simulated();
    const made = await b.worklogs!.create!(meta(), ref(sim.tasks[0]), { time: { ...date("2020-02-29"), seconds: 3600 }, comment: "old" }, { idempotencyKey: "k" });
    expect(made.span).toMatchObject({ date: "2020-02-29" });
    expect(made.createdAt).toBeGreaterThan(Date.UTC(2026, 0, 1));
  });

  it("at most 24 hours in an entry, and a day, never a session", async () => {
    const { b, sim } = simulated();
    expect(await errorOf(b.worklogs!.create!(meta(), ref(sim.tasks[0]), { time: { ...date("2026-10-14"), seconds: 25 * 3600 }, comment: "" }, { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid" });
    expect((await raw(sim, `/tasks/${sim.tasks[0].id}/timelogs`, { method: "POST", form: { hours: "25", trackedDate: "2026-10-14" } })).status).toBe(400);
    const err = await errorOf(b.worklogs!.create!(meta(), ref(sim.tasks[0]), { time: { kind: "session", start: instant(Date.UTC(2026, 9, 14, 8)), seconds: 600 }, comment: "" }, { idempotencyKey: "k" }));
    expect(err).toMatchObject({ kind: "invalid" });
  });

  it("the feed is a window of the user's timelogs updated in the last 30 days, always read whole", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const mine = sim.log(t, { hours: 1, trackedDate: "2026-10-14" });
    const old = sim.log(t, { hours: 1, trackedDate: "2026-08-14" });
    old.updated = Date.now() - 40 * DAY;
    const theirs = sim.log(t, { hours: 1, trackedDate: "2026-10-14", user: sim.anna.id });
    const first = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    expect(first.items.map((w) => w.remoteId)).toEqual([mine.id]);
    expect(first.items.map((w) => w.remoteId)).not.toContain(theirs.id);
    expect(first.checkpoint).not.toBeNull();
    old.updated = Date.now();
    const again = await readPass((q) => b.worklogs!.changed!(meta(), q), first.checkpoint);
    expect(again.items.map((w) => w.remoteId).sort()).toEqual([mine.id, old.id].sort());
    expect(again.gone).toEqual([]);
  });

  it("deleting twice is a success; another person's timelog is read, never editable; an approved or pending one is locked", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const r = ref(t);
    const mine = sim.log(t, { hours: 0.5, trackedDate: "2026-10-14" });
    const theirs = sim.log(t, { hours: 0.25, trackedDate: "2026-10-14", user: sim.anna.id });
    const locked = sim.log(t, { hours: 0.75, trackedDate: "2026-10-13" });
    sim.outside.approve(locked);
    const list = await b.worklogs!.list(meta(), r);
    const by = (id: string) => list.find((w) => w.remoteId === id)!;
    expect(by(theirs.id)).toMatchObject({ authorRemoteId: sim.anna.id, editable: { update: false, delete: false } });
    expect(by(locked.id)).toMatchObject({ approval: "approved", locked: { cause: "approved" }, editable: { update: false, delete: false } });
    sim.outside.submit(mine);
    expect((await b.worklogs!.list(meta(), r)).find((w) => w.remoteId === mine.id)).toMatchObject({ approval: "submitted", locked: { cause: "submitted" } });
    expect(await errorOf(b.worklogs!.update!(meta(), r, locked.id, { time: { ...date("2026-10-13"), seconds: 600 }, comment: "x" }, {}))).toMatchObject({ kind: "forbidden" });
    expect(await errorOf(b.worklogs!.delete!(meta(), r, theirs.id, {}))).toMatchObject({ kind: "forbidden" });
    mine.approval = "Draft";
    await b.worklogs!.delete!(meta(), r, mine.id, {});
    await b.worklogs!.delete!(meta(), r, mine.id, {});
    expect(sim.timelogs.some((l) => l.id === mine.id)).toBe(false);
    expect(await b.worklogs!.get!(meta(), r, mine.id)).toBeNull();
  });

  it("offers the visible timelog categories, and refuses one that is not", async () => {
    const { b, sim } = simulated();
    sim.category("Design");
    sim.category("Meetings");
    sim.category("Old", true);
    const got = await b.worklogs!.activities!(meta(), {}, 10);
    expect(got.items.map((i) => i.name).sort()).toEqual(["Design", "Meetings"]);
    expect((await b.worklogs!.activities!(meta(), {}, 1)).complete).toBe(false);
    expect(await errorOf(b.worklogs!.create!(meta(), ref(sim.tasks[0]), { time: { ...date("2026-10-14"), seconds: 600 }, comment: "", activityId: "nope" }, { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid" });
  });
});

describe("wrike, webhooks", () => {
  const secret = "webhook-secret";
  const events = [{ eventType: "TaskStatusChanged", taskId: "IEAAJKV3KQ000001" }];

  it("accepts a delivery signed with the webhook's secret and refuses any other", () => {
    const { sim } = simulated();
    const d = sim.webhook(events, { secret });
    expect(wrikeWebhook.verify(d.headers, d.rawBody, secret)).toBe(true);
    expect(wrikeProvider.webhook!.verify({ headers: d.headers, body: d.rawBody }, secret)).toBe(true);
    const wrong = sim.webhook(events, { secret, signedWith: "other" });
    expect(wrikeWebhook.verify(wrong.headers, wrong.rawBody, secret)).toBe(false);
    expect(wrikeWebhook.verify(d.headers, d.rawBody.replace("TaskStatusChanged", "TaskDeleted"), secret)).toBe(false);
    expect(wrikeWebhook.verify({}, d.rawBody, secret)).toBe(false);
    expect(wrikeWebhook.verify({ "x-hook-secret": "zz" }, d.rawBody, secret)).toBe(false);
    expect(wrikeWebhook.verify(d.headers, d.rawBody, "")).toBe(false);
  });

  it("has no delivery id, and dates a delivery by its latest event", () => {
    const { sim } = simulated();
    const d = sim.webhook(events, { secret, ageMs: 5000 });
    expect(wrikeProvider.webhook!.deliveryId({ headers: d.headers, body: d.rawBody })).toBeNull();
    const at = wrikeWebhook.sentAt(d.rawBody)!;
    expect(Date.now() - at).toBeGreaterThanOrEqual(4000);
    expect(wrikeProvider.webhook!.sentAt!({ headers: d.headers, body: d.rawBody })).toBe(at);
    expect(wrikeWebhook.sentAt("[]")).toBeNull();
    expect(wrikeWebhook.sentAt("not json")).toBeNull();
  });

  it("names the declared events a delivery holds", () => {
    const body = (types: string[]) => JSON.stringify(types.map((eventType) => ({ eventType })));
    expect(wrikeWebhook.events(body(["TaskStatusChanged", "TaskDeleted"]))).toEqual(["issueChanged", "issueRemoved"]);
    expect(wrikeWebhook.events(body(["CommentAdded"]))).toEqual(["commentAdded"]);
    expect(wrikeWebhook.events(body(["TimelogChanged"]))).toEqual(["worklogChanged"]);
    expect(wrikeWebhook.events(body(["FolderCreated"]))).toEqual([]);
    expect(wrikeWebhook.events("[]")).toEqual([]);
    expect(wrikeWebhook.events("nope")).toEqual([]);
  });
});

describe("wrike, errors and limits", () => {
  it("a bad token is auth (401)", async () => {
    const { b } = simulated({ token: "wrong" });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "auth" });
  });

  it("a revoked token is auth on every call", async () => {
    const { b, sim } = simulated();
    expect((await b.verify(meta())).remoteId).toBe(sim.me.id);
    sim.revoke();
    expect(await errorOf(pass(b))).toMatchObject({ kind: "auth" });
  });

  it("an exhausted quota is a wait: 429 with Retry-After in seconds", async () => {
    const { b, sim } = simulated();
    sim.exhaust();
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 30_000, remaining: 0 } });
    sim.refill();
    expect((await b.verify(meta())).name).toBe("Mario Rossi");
  });

  it("a missing task is notFound where an operation needs it, null where a lookup asks", async () => {
    const { b } = simulated();
    const ghost = { remoteId: "IEAAJKV3KQZZZZZZ", key: "WRIKE-1" };
    expect(await b.getIssue(meta(), ghost)).toBeNull();
    expect(await errorOf(b.transitions!.list!(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.comments!.list(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.watch!(meta(), ghost, true))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.worklogs!.list(meta(), ghost))).toMatchObject({ kind: "notFound" });
  });

  it("a refusal carries Wrike's own words", async () => {
    const { b } = simulated();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "access_forbidden", errorDescription: "Access Forbidden" }), { status: 403 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "forbidden", message: expect.stringContaining("Access Forbidden") });
  });

  it("knows who the token belongs to; Wrike gives no budget figure", async () => {
    const { b, sim } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: sim.me.id, name: "Mario Rossi", email: "mario@acme.example" });
    expect((await b.probe(meta())).rateLimit).toBeUndefined();
  });
});
