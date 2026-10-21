import { describe, expect, it, vi } from "vitest";
import { markdown, timeZone } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import type { Checkpoint } from "../types";
import { notionSimulator, WORKSPACE_BOT } from "./simulator";
import { blocksToMarkdown, markdownToRichText, notionProvider, notionWebhook, richToMarkdown, RICH_ELEMENTS_MAX, RICH_TEXT_MAX, type NotionOptions } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "104.18.0.1", family: 4 }]),
}));

const A = "6f1c2a40-aaaa-4bbb-8ccc-012345678901";
const KEY_A = "6f1c2a40aaaa4bbb8ccc012345678901";

type Sim = ReturnType<typeof notionSimulator>;

function simulated(o: { owner?: "workspace" | "user"; options?: Partial<Record<keyof NotionOptions, unknown>>; token?: string; userInfo?: boolean; select?: boolean } = {}) {
  const sim = notionSimulator(undefined, { owner: o.owner, userInfo: o.userInfo });
  const anna = sim.addUser("Anna Bianchi");
  const tasks = sim.addDatabase("Tasks", { options: ["Not started", "Planned", "In progress", "Done"], type: o.select ? "select" : "status" });
  sim.addDatabase("Wiki", { options: ["Draft", "Published"] });
  sim.add("Tasks", "Login fails on Safari", { id: A, status: "Planned", due: "2026-10-30", tags: ["bug"] });
  sim.add("Tasks", "Export to CSV", { status: "In progress", due: { start: "2026-10-30T23:30:00.000+00:00", end: null, time_zone: null }, assignees: [sim.me, anna] });
  sim.add("Tasks", "Rotate certificates", { status: "Not started", due: { start: "2026-10-30T09:00:00.000", end: null, time_zone: "Europe/Rome" } });
  sim.add("Tasks", "Anna's own", { assignees: [anna] });
  sim.add("Wiki", "Onboarding guide", { status: "Draft" });
  sim.live();
  vi.stubGlobal("fetch", sim.fetch);
  const options = { database: tasks.id, user: sim.me.id, due: "Due", ...o.options };
  const conn = {
    id: 9,
    userId: 1,
    type: "notion" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: sim.me.id,
    options,
    timeZone: timeZone("Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, anna, tasks, conn, b: bindTracker(notionProvider, conn) };
}

trackerConformance("notion (simulated)", async () => {
  const { conn } = simulated();
  return { provider: notionProvider, conn, key: KEY_A, writable: true, url: `https://www.notion.so/acme/Login-fails-on-Safari-${KEY_A}` };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
type Bound = ReturnType<typeof simulated>["b"];
const pass = (b: Bound, since: Checkpoint | null = null) => readPass((q) => b.listChanged(meta(), q), since);
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; status?: number; message: string; transient?: boolean; rateLimit?: { retryAfterMs?: number } });
const refOf = (sim: Sim, id: string) => ({ remoteId: sim.page(id).id, key: sim.page(id).id.replace(/-/g, "") });
const titles = (xs: { title: string }[]) => xs.map((i) => i.title).sort();
const posts = (sim: Sim) => sim.calls.filter((c) => c.method === "POST" && c.path.endsWith("/query"));

describe("notion, pages", () => {
  it("lists the pages assigned to the user, keyed by id, the status property as status and the database as container", async () => {
    const { b, sim, tasks } = simulated();
    const all = await pass(b);
    expect(all.items.map((i) => [i.title, i.status.name, i.status.category]).sort()).toEqual([
      ["Export to CSV", "In progress", "doing"],
      ["Login fails on Safari", "Planned", "todo"],
      ["Rotate certificates", "Not started", "todo"],
    ]);
    const login = all.items.find((i) => i.key === KEY_A)!;
    expect(login).toMatchObject({
      remoteId: A,
      url: `https://www.notion.so/Login-fails-on-Safari-${KEY_A}`,
      type: { id: "page", level: "standard" },
      container: { remoteId: tasks.id, key: tasks.id.replace(/-/g, ""), name: "Tasks", kind: "database" },
      status: { source: { kind: "projectField", containerRemoteId: tasks.id } },
    });
    expect(all.checkpoint).not.toBeNull();
    expect(all.gone).toEqual([]);
    // Nothing of another database, or of someone else's.
    expect(titles(all.items)).not.toContain("Onboarding guide");
    expect(titles(all.items)).not.toContain("Anna's own");
    expect(sim.calls.every((c) => c.path.startsWith("/v1/"))).toBe(true);
  });

  it("reads people with their names; a page without a status is not triaged", async () => {
    const { b, sim } = simulated();
    const i = (await b.getIssue(meta(), refOf(sim, sim.pages[1].id)))!;
    expect(i.assignees.map((a) => a.name)).toEqual(["Mario Rossi", "Anna Bianchi"]);
    sim.add("Tasks", "Bare", { status: null });
    const bare = (await pass(b)).items.find((x) => x.title === "Bare")!;
    expect(bare.status).toMatchObject({ id: "none", category: "triage" });
  });

  it("a due date is a day, an instant with an offset (the day in the user's zone), or a time in the property's own zone", async () => {
    const { b, sim } = simulated();
    const due = async (n: number) => (await b.getIssue(meta(), refOf(sim, sim.pages[n].id)))?.due;
    expect(await due(0)).toBe("2026-10-30");
    // 23:30 UTC on the 30th is already the 31st in Rome (CET after 25 October).
    expect(await due(1)).toBe("2026-10-31");
    // No offset: written in Europe/Rome, the date it says.
    expect(await due(2)).toBe("2026-10-30");
    // No due property configured: no due date.
    const none = simulated({ options: { due: undefined } });
    expect((await none.b.getIssue(meta(), refOf(none.sim, A)))?.due).toBeNull();
  });

  it("the id is the identity people see: 32 hex characters, found by id, key or link, in the API's dashed form too", async () => {
    const { b } = simulated();
    expect(b.normalizeKey(KEY_A)).toBe(KEY_A);
    expect(b.normalizeKey(A)).toBe(KEY_A);
    expect(b.normalizeKey(KEY_A.toUpperCase())).toBe(KEY_A);
    expect(b.normalizeKey(KEY_A.slice(1))).toBeNull();
    expect(b.normalizeKey(`${KEY_A}0`)).toBeNull();
    expect(b.normalizeKey("not-an-id")).toBeNull();
    for (const handle of [{ key: KEY_A }, { remoteId: A }, { key: A }]) {
      const f = await b.findIssue(meta(), handle);
      expect(f.kind === "found" && f.issue.remoteId).toBe(A);
    }
  });

  it("parses the links of the service, and nothing else", () => {
    const { b } = simulated();
    expect(b.parseRef(KEY_A)).toEqual({ key: KEY_A });
    expect(b.parseRef(`https://www.notion.so/acme/Login-fails-on-Safari-${KEY_A}`)).toEqual({ key: KEY_A });
    expect(b.parseRef(`https://www.notion.so/Login-fails-on-Safari-${KEY_A}?pvs=4`)).toEqual({ key: KEY_A });
    expect(b.parseRef(`https://notion.so/${KEY_A}`)).toEqual({ key: KEY_A });
    // Peeked in a database view: the path is the database's, ?p= the page's.
    expect(b.parseRef(`https://www.notion.so/acme/${"d".repeat(32)}?v=${"e".repeat(32)}&p=${KEY_A}&pm=s`)).toEqual({ key: KEY_A });
    expect(b.parseRef(`http://www.notion.so/${KEY_A}`)).toBeNull();
    expect(b.parseRef(`https://notion.example.com/${KEY_A}`)).toBeNull();
    expect(b.parseRef("https://www.notion.so/acme/Some-page-title")).toBeNull();
    expect(b.parseRef("https://www.notion.so/")).toBeNull();
  });

  it("a database's link is no page: found as none, never as an error", async () => {
    const { b, tasks } = simulated();
    const key = tasks.id.replace(/-/g, "");
    expect(b.parseRef(`https://www.notion.so/acme/${key}?v=${"e".repeat(32)}`)).toEqual({ key });
    expect((await b.findIssue(meta(), { key })).kind).toBe("none");
    expect(await b.getIssue(meta(), { remoteId: tasks.id, key })).toBeNull();
  });

  it("a page of another database, or moved out of it, is not found", async () => {
    const { b, sim } = simulated();
    const wiki = sim.pages.find((p) => p.title === "Onboarding guide")!;
    expect((await b.findIssue(meta(), { remoteId: wiki.id })).kind).toBe("none");
    sim.outside.moveOut(A);
    expect((await b.findIssue(meta(), { key: KEY_A })).kind).toBe("none");
    expect(await b.getIssue(meta(), refOf(sim, A))).toBeNull();
  });

  it("has no query language and keeps time in inkledger", () => {
    expect(notionProvider.capabilities.time).toEqual({ mode: "local", remoteTotals: false });
    expect(notionProvider.worklogs).toBeUndefined();
    expect("query" in notionProvider).toBe(false);
    expect("translate" in notionProvider).toBe(false);
  });

  it("searches the titles of the database (any case), not the workspace", async () => {
    const { b } = simulated();
    const r = await b.searchText!(meta(), "safari", 10);
    expect(titles(r.items)).toEqual(["Login fails on Safari"]);
    expect(r.complete).toBe(true);
    // Another user's pages are in the database too: search is not limited to the user's.
    expect(titles((await b.searchText!(meta(), "own", 10)).items)).toEqual(["Anna's own"]);
    expect(titles((await b.searchText!(meta(), "guide", 10)).items)).toEqual([]);
  });
});

describe("notion, passes", () => {
  it("last_edited_time is rounded to the minute: a pass reads two minutes back, so a change inside the checkpoint's minute is not lost", async () => {
    const { b, sim } = simulated();
    const first = await pass(b);
    sim.outside.rename(A, "Login fails on Safari 17");
    sim.calls.length = 0;
    const next = await pass(b, first.checkpoint);
    // The simulator stamps the minute, never the second.
    expect(next.items.map((i) => i.title)).toEqual(["Login fails on Safari 17"]);
    expect(new Date(next.items[0].updatedAt!).getUTCSeconds()).toBe(0);
    const decoded = JSON.parse(Buffer.from((first.checkpoint as string).slice(4), "base64url").toString("utf8")) as { d: { at: number } };
    const delta = posts(sim).find((c) => !c.search.includes("filter_properties"))!;
    const from = (delta.body.filter as { and: { last_edited_time?: { on_or_after: string } }[] }).and[1].last_edited_time!.on_or_after;
    expect(Date.parse(from)).toBe(decoded.d.at - 120_000);
    // What was not touched is not read again.
    expect(titles((await pass(b, next.checkpoint)).items)).not.toContain("Export to CSV");
  });

  it("reads a long list a page at a time (100 at most), once each, and a token of another pass is refused", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 130; n++) sim.add("Tasks", `Bulk ${n}`);
    sim.calls.length = 0;
    const all = await pass(b);
    expect(all.items).toHaveLength(133);
    expect(new Set(all.items.map((i) => i.remoteId)).size).toBe(133);
    expect(all.pages).toBe(2);
    // The list's two pages, then the ids of everything assigned (two more, only the title asked for).
    expect(posts(sim)).toHaveLength(4);
    expect(posts(sim).filter((c) => c.search.includes("filter_properties"))).toHaveLength(2);
    expect(posts(sim).every((c) => c.body.page_size === 100)).toBe(true);
    const first = await b.listChanged(meta(), { since: null, page: null });
    expect(first.last).toBe(false);
    const other = await pass(b);
    if (!first.last) await expect(b.listChanged(meta(), { since: other.checkpoint, page: first.next })).rejects.toMatchObject({ kind: "invalidCheckpoint" });
  });

  it("refuses a checkpoint it didn't write", async () => {
    const { b } = simulated();
    await expect(b.listChanged(meta(), { since: "cp1.eyJ9" as Checkpoint, page: null })).rejects.toMatchObject({ kind: "invalidCheckpoint" });
    await expect(b.listChanged(meta(), { since: null, page: "pg1.eyJ9" as never })).rejects.toMatchObject({ kind: "invalidCheckpoint" });
  });

  it("a page in the trash is in no query: it is reported deleted from the ids of the last pass, and restored it is an item again", async () => {
    const { b, sim } = simulated();
    const first = await pass(b);
    sim.outside.archive(sim.pages[2].id);
    const next = await pass(b, first.checkpoint);
    expect(next.items).toEqual([]);
    expect(next.gone).toEqual([{ remoteId: sim.pages[2].id, reason: "deleted" }]);
    // Still readable by its id, but not an item.
    expect(await b.getIssue(meta(), refOf(sim, sim.pages[2].id))).toBeNull();
    // Told once: the next checkpoint no longer holds it.
    expect((await pass(b, next.checkpoint)).gone).toEqual([]);
    sim.outside.unarchive(sim.pages[2].id);
    const back = await pass(b, next.checkpoint);
    expect(back.items.map((i) => i.title)).toEqual(["Rotate certificates"]);
    expect(back.gone).toEqual([]);
  });

  it("a page removed for good, or whose database stopped being shared, is deleted; one given to someone else is no departure", async () => {
    const { b, sim, anna } = simulated();
    const first = await pass(b);
    sim.outside.deleteForever(A);
    sim.outside.assign(sim.pages[1].id, anna);
    const next = await pass(b, first.checkpoint);
    expect(next.gone).toEqual([{ remoteId: A, reason: "deleted" }]);
    expect(next.items).toEqual([]);
    expect(await b.getIssue(meta(), { remoteId: A, key: KEY_A })).toBeNull();
  });

  it("a database not shared (with the integration) reads as gone: a clear notFound", async () => {
    const { b, sim } = simulated();
    sim.outside.unshare("Tasks");
    expect(await errorOf(b.listChanged(meta(), { since: null, page: null }))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.probe(meta()))).toMatchObject({ kind: "notFound" });
    expect(await b.getIssue(meta(), { remoteId: A, key: KEY_A })).toBeNull();
  });
});

describe("notion, properties", () => {
  it("a renamed property is a clear error, and the option follows the rename", async () => {
    const { b, sim, conn } = simulated();
    sim.outside.renameColumn("Tasks", "Status", "State");
    const err = await errorOf(b.listChanged(meta(), { since: null, page: null }));
    expect(err).toMatchObject({ kind: "invalid" });
    expect(err?.message).toContain('"Status"');
    const follows = bindTracker(notionProvider, { ...conn, options: { ...conn.options, status: "State" } });
    expect((await pass(follows)).items).toHaveLength(3);
  });

  it("a property of the wrong type is refused, and the assignee and due are found by name", async () => {
    const { conn, sim } = simulated();
    const wrong = bindTracker(notionProvider, { ...conn, options: { ...conn.options, status: "Assignee" } });
    expect(await errorOf(wrong.probe(meta()))).toMatchObject({ kind: "invalid" });
    const noDue = bindTracker(notionProvider, { ...conn, options: { ...conn.options, due: "Nope" } });
    expect(await errorOf(noDue.probe(meta()))).toMatchObject({ kind: "invalid" });
    sim.outside.renameColumn("Tasks", "Assignee", "Owner");
    const owner = bindTracker(notionProvider, { ...conn, options: { ...conn.options, assignee: "Owner" } });
    expect((await pass(owner)).items).toHaveLength(3);
  });

  it("the options are checked: the database's id, in any form, is required", () => {
    expect(() => notionProvider.parseOptions({})).toThrow(/database/);
    expect(() => notionProvider.parseOptions({ database: "abc" })).toThrow(/database/);
    expect(() => notionProvider.parseOptions({ database: KEY_A, stray: 1 })).toThrow();
    expect(notionProvider.parseOptions({ database: A.toUpperCase() })).toMatchObject({ database: KEY_A, status: "Status", assignee: "Assignee", categories: {} });
  });
});

describe("notion, workflow", () => {
  it("a native status takes its category from its group; the connection's mapping overrides it", async () => {
    const { b, sim, conn } = simulated();
    const items = (await pass(b)).items;
    const by = (t: string) => items.find((i) => i.title === t)!;
    expect(by("Login fails on Safari").status).toMatchObject({ name: "Planned", category: "todo", categoryOrigin: { by: "native" }, nativeReason: "To-do" });
    expect(by("Export to CSV").status).toMatchObject({ category: "doing", categoryOrigin: { by: "native" }, nativeReason: "In progress" });
    sim.outside.setStatus(A, "Done");
    const done = await b.getIssue(meta(), refOf(sim, A));
    expect(done?.status).toMatchObject({ category: "done", nativeReason: "Complete" });
    // A mapping by id before name, in any case.
    const planned = sim.option(sim.db("Tasks"), "Planned").id;
    const mapped = bindTracker(notionProvider, { ...conn, options: { ...conn.options, categories: { [planned]: "doing", DONE: "cancelled" } } });
    expect((await mapped.getIssue(meta(), refOf(sim, A)))?.status).toMatchObject({ category: "cancelled", categoryOrigin: { by: "mapping" } });
    sim.outside.setStatus(A, "Planned");
    expect((await mapped.getIssue(meta(), refOf(sim, A)))?.status.category).toBe("doing");
  });

  it("a select property has no meaning of its own: only the mapping gives a category, todo otherwise", async () => {
    const plain = simulated({ select: true });
    const items = (await pass(plain.b)).items;
    expect(items.every((i) => i.status.category === "todo" && i.status.categoryOrigin.by === "mapping")).toBe(true);
    const mapped = simulated({ select: true, options: { categories: { "in progress": "doing", Done: "done" } } });
    expect((await pass(mapped.b)).items.find((i) => i.title === "Export to CSV")?.status.category).toBe("doing");
    // Moves along options of a select too.
    const ways = await mapped.b.transitions!.list!(meta(), refOf(mapped.sim, A));
    const done = ways.find((w) => w.name === "Done")!;
    expect((await mapped.b.transitions!.apply!(meta(), refOf(mapped.sim, A), done.id, {}))?.status).toMatchObject({ name: "Done", category: "done" });
  });

  it("lists the options of the status property, in order, from any status", async () => {
    const { b, sim, tasks } = simulated();
    const probe = await b.probe(meta());
    expect(probe.activeSources).toHaveLength(1);
    expect(probe.activeSources[0]).toMatchObject({ kind: "projectField", transitions: "direct", ref: { kind: "projectField", containerRemoteId: tasks.id }, name: "Tasks · Status" });
    const all = await b.statuses!(meta(), probe.activeSources[0]);
    expect(all.map((s) => [s.name, s.category, s.order])).toEqual([
      ["Not started", "todo", 0],
      ["Planned", "todo", 1],
      ["In progress", "doing", 2],
      ["Done", "done", 3],
    ]);
    const ways = await b.transitions!.list!(meta(), refOf(sim, A));
    expect(ways.map((w) => w.name)).toEqual(["Not started", "In progress", "Done"]);
    expect(ways.every((w) => w.remoteUrl?.startsWith("https://www.notion.so/"))).toBe(true);
    // Another source is not this one's.
    expect(await b.statuses!(meta(), { kind: "projectField", transitions: "direct", name: "Wiki", ref: { kind: "projectField", fieldRemoteId: "x", containerRemoteId: sim.db("Wiki").id } })).toEqual([]);
  });

  it("moves a page by writing the option's id on the property's id (not their names)", async () => {
    const { b, sim } = simulated();
    const done = (await b.transitions!.list!(meta(), refOf(sim, A))).find((w) => w.name === "Done")!;
    const after = await b.transitions!.apply!(meta(), refOf(sim, A), done.id, {});
    expect(after?.status).toMatchObject({ name: "Done", category: "done" });
    const patch = sim.calls.filter((c) => c.method === "PATCH").at(-1)!;
    const col = sim.db("Tasks").columns.find((c) => c.name === "Status")!;
    expect(patch.body).toEqual({ properties: { [col.id]: { status: { id: done.id } } } });
    // The next pass sees it: the edit is a change.
    expect((await b.getIssue(meta(), refOf(sim, A)))?.status.name).toBe("Done");
  });

  it("refuses an option that isn't one, and a page in the trash can't be moved", async () => {
    const { b, sim } = simulated();
    expect(await errorOf(b.transitions!.apply!(meta(), refOf(sim, A), "nope", {}))).toMatchObject({ kind: "invalid" });
    sim.outside.archive(A);
    const done = (await b.transitions!.list!(meta(), refOf(sim, sim.pages[1].id))).find((w) => w.name === "Done")!;
    expect(await errorOf(b.transitions!.apply!(meta(), refOf(sim, A), done.id, {}))).toMatchObject({ kind: "invalid" });
    expect(await errorOf(b.transitions!.list!(meta(), refOf(sim, A)))).toMatchObject({ kind: "notFound" });
  });
});

describe("notion, comments and description", () => {
  it("lists the comments of the page, oldest first, with their authors by name (created_by is only an id), and not those on a block", async () => {
    const { b, sim, anna } = simulated();
    sim.outside.comment(A, "First **look**");
    sim.outside.comment(A, "Second", anna);
    sim.outside.commentOnBlock(A, "on a paragraph");
    const list = await b.comments!.list(meta(), refOf(sim, A));
    expect(list.map((c) => [c.author.name, c.body.kind === "structured" ? c.body.preview : ""])).toEqual([
      ["Mario Rossi", "First **look**"],
      ["Anna Bianchi", "Second"],
    ]);
    expect(list[0].body).toMatchObject({ kind: "structured", format: "rich" });
    // The author's name is asked once for each person.
    expect(sim.calls.filter((c) => c.path.startsWith("/v1/users/")).length).toBe(2);
  });

  it("writes markdown as rich text; the bot is the author; features Notion keeps only as text are warned", async () => {
    const { b, sim } = simulated();
    const r = await b.comments!.add!(meta(), refOf(sim, A), markdown("Checked **twice**, see [the log](https://logs.example/1) and `x`\n\n| a | b |\n|---|---|"), { idempotencyKey: "k" });
    expect(r.warnings).toEqual([{ code: "approximated", feature: "table" }]);
    expect(r.comment?.author).toMatchObject({ remoteId: WORKSPACE_BOT });
    expect(r.comment?.body.kind === "structured" && r.comment.body.preview).toContain("**twice**");
    expect(r.comment?.body.kind === "structured" && r.comment.body.preview).toContain("[the log](https://logs.example/1)");
    expect(r.comment?.body.kind === "structured" && r.comment.body.preview).toContain("`x`");
    expect((await b.comments!.list(meta(), refOf(sim, A))).map((c) => c.id)).toContain(r.comment?.id);
  });

  it("a text over 2,000 characters is split into elements; more than 100 elements are refused before the call", async () => {
    const { b, sim } = simulated();
    const long = "x".repeat(RICH_TEXT_MAX * 2 + 5);
    expect(markdownToRichText(long).map((r) => r.text.content.length)).toEqual([2000, 2000, 5]);
    const r = await b.comments!.add!(meta(), refOf(sim, A), markdown(long), { idempotencyKey: "k" });
    expect(r.comment?.body.kind === "structured" && r.comment.body.preview.length).toBe(long.length);
    const many = Array.from({ length: RICH_ELEMENTS_MAX }, (_, n) => `**b${n}** `).join("");
    const before = sim.calls.length;
    expect(await errorOf(b.comments!.add!(meta(), refOf(sim, A), markdown(many), { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid" });
    expect(sim.calls.length).toBe(before);
  });

  it("an integration that may not read comments is forbidden", async () => {
    const { b, sim } = simulated();
    sim.state.commentsAllowed = false;
    expect(await errorOf(b.comments!.list(meta(), refOf(sim, A)))).toMatchObject({ kind: "forbidden", status: 403 });
    expect(await errorOf(b.comments!.add!(meta(), refOf(sim, A), markdown("hi"), { idempotencyKey: "k" }))).toMatchObject({ kind: "forbidden" });
  });

  it("an author the integration can't read shows as its id", async () => {
    const { b, sim } = simulated();
    sim.outside.comment(A, "hello");
    const list = await b.comments!.list(meta(), refOf(sim, A));
    expect(list[0].author.name).toBe("Mario Rossi");
    sim.users.delete(sim.me.id);
    expect((await b.comments!.list(meta(), refOf(sim, A)))[0].author).toMatchObject({ remoteId: sim.me.id, name: sim.me.id });
  });

  it("the description is the page's text blocks, top level only", async () => {
    const { b, sim } = simulated();
    expect(await b.description!(meta(), refOf(sim, A))).toBeNull();
    sim.outside.setBody(A, [
      { type: "heading_2", text: "Steps" },
      { type: "numbered_list_item", text: "open" },
      { type: "numbered_list_item", text: "fail" },
      { type: "paragraph", text: "Then **nothing**." },
      { type: "toggle", text: "hidden inside", children: true },
    ]);
    const d = await b.description!(meta(), refOf(sim, A));
    expect(d).toMatchObject({ kind: "structured", format: "rich" });
    expect(d?.kind === "structured" && d.preview).toBe("## Steps\n\n1. open\n2. fail\n\nThen **nothing**.");
  });

  it("rich text and blocks as Markdown", () => {
    expect(
      richToMarkdown([
        { type: "text", plain_text: "a", annotations: { bold: true }, href: null },
        { type: "text", plain_text: "b", annotations: { code: true }, href: null },
        { type: "text", plain_text: "c", annotations: { italic: true, strikethrough: true }, href: "https://x.example" },
      ]),
    ).toBe("**a**`b`[*~~c~~*](https://x.example)");
    expect(blocksToMarkdown([])).toBe("");
  });
});

describe("notion, who the user is", () => {
  it("an internal integration belongs to the workspace: the user is named in the options, by id or by email", async () => {
    const byId = simulated();
    expect(await byId.b.verify(meta())).toMatchObject({ remoteId: byId.sim.me.id, name: "Mario Rossi", email: "mario@acme.example" });
    const byEmail = simulated({ options: { user: "MARIO@acme.example" } });
    expect(await byEmail.b.verify(meta())).toMatchObject({ remoteId: byEmail.sim.me.id });
    const none = simulated({ options: { user: undefined } });
    expect(await errorOf(none.b.verify(meta()))).toMatchObject({ kind: "invalid" });
    expect((await errorOf(none.b.verify(meta())))?.message).toContain("belongs to the workspace");
  });

  it("a public integration names the user who authorized it", async () => {
    const { b, sim } = simulated({ owner: "user", options: { user: undefined } });
    expect(await b.verify(meta())).toMatchObject({ remoteId: sim.me.id, name: "Mario Rossi" });
  });

  it("an email needs the capability to read user information; an unknown user is refused", async () => {
    const hidden = simulated({ userInfo: false, options: { user: "mario@acme.example" } });
    expect(await errorOf(hidden.b.verify(meta()))).toMatchObject({ kind: "invalid" });
    const unknown = simulated({ options: { user: "nobody@acme.example" } });
    expect(await errorOf(unknown.b.verify(meta()))).toMatchObject({ kind: "invalid" });
    const ghost = simulated({ options: { user: "0".repeat(32) } });
    expect(await errorOf(ghost.b.verify(meta()))).toMatchObject({ kind: "notFound" });
    const garbled = simulated({ options: { user: "not an id" } });
    expect(await errorOf(garbled.b.verify(meta()))).toMatchObject({ kind: "invalid" });
  });
});

describe("notion, errors", () => {
  it("a token the service refuses is auth; a missing page is notFound; a missing capability is forbidden", async () => {
    const revoked = simulated();
    revoked.sim.revoke();
    expect(await errorOf(revoked.b.verify(meta()))).toMatchObject({ kind: "auth", status: 401 });
    const wrong = simulated({ token: "secret_wrong" });
    expect(await errorOf(wrong.b.probe(meta()))).toMatchObject({ kind: "auth" });
    const { b } = simulated();
    expect(await errorOf(b.comments!.list(meta(), { remoteId: "1".repeat(8) + "-1111-4111-8111-" + "1".repeat(12), key: "x" }))).toMatchObject({ kind: "notFound", status: 404 });
  });

  it("over the rate limit is a 429 with Retry-After (seconds), transient", async () => {
    const { b, sim } = simulated();
    sim.exhaust();
    const err = await errorOf(b.verify(meta()));
    expect(err).toMatchObject({ kind: "rateLimit", status: 429, transient: true, rateLimit: { retryAfterMs: 2000, remaining: 0 } });
    sim.state.retryAfter = 30;
    expect(await errorOf(b.verify(meta()))).toMatchObject({ rateLimit: { retryAfterMs: 30_000 } });
    sim.refill();
    expect(await b.verify(meta())).toMatchObject({ name: "Mario Rossi" });
    expect((await b.probe(meta())).rateLimit).toEqual({ perSecond: 3, origin: "typical" });
  });

  it("answers outside the contract are incompatible, a server failure is unavailable", async () => {
    const { b } = simulated();
    vi.stubGlobal("fetch", async () => new Response("<html>oops</html>", { status: 200 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "incompatible" });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ object: "error", status: 503, code: "service_unavailable", message: "later" }), { status: 503 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "unavailable", transient: true });
  });
});

describe("notion webhooks", () => {
  const request = (d: { rawBody: string; headers: Record<string, string> }) => ({ headers: d.headers, body: d.rawBody });

  it("accepts a delivery signed with the verification token and refuses the rest", () => {
    const { sim } = simulated();
    const secret = sim.verificationToken;
    const d = sim.webhook("page.properties_updated", A, { id: "evt-1", timestamp: "2026-10-21T10:00:00.000Z" });
    expect(d.headers["x-notion-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(notionProvider.webhook!.verify(request(d), secret)).toBe(true);
    expect(notionProvider.webhook!.verify(request(d), "other")).toBe(false);
    expect(notionProvider.webhook!.verify(request(d), "")).toBe(false);
    // A body changed after signing, a bad signature, none, a signature of another scheme.
    expect(notionProvider.webhook!.verify({ headers: d.headers, body: `${d.rawBody} ` }, secret)).toBe(false);
    expect(notionProvider.webhook!.verify({ headers: { "x-notion-signature": "sha256=zz" }, body: d.rawBody }, secret)).toBe(false);
    expect(notionProvider.webhook!.verify({ headers: {}, body: d.rawBody }, secret)).toBe(false);
    expect(notionProvider.webhook!.verify({ headers: { "x-notion-signature": d.headers["x-notion-signature"].replace("sha256=", "") }, body: d.rawBody }, secret)).toBe(false);
    const wrong = sim.webhook("page.properties_updated", A, { signedWith: "other" });
    expect(notionProvider.webhook!.verify(request(wrong), secret)).toBe(false);
    expect(notionWebhook.verify({ secret, rawBody: d.rawBody, headers: new Headers({ "X-Notion-Signature": d.headers["x-notion-signature"] }) })).toBe(true);
  });

  it("a delivery has its own id and a time; a retry repeats the id", () => {
    const { sim } = simulated();
    const d = sim.webhook("comment.created", "c1", { id: "evt-2", timestamp: "2026-10-21T10:00:00.000Z" });
    expect(notionProvider.webhook!.deliveryId(request(d))).toBe("evt-2");
    expect(notionProvider.webhook!.sentAt!(request(d))).toBe(Date.parse("2026-10-21T10:00:00.000Z"));
    expect(notionProvider.webhook!.deliveryId({ headers: {}, body: "not json" })).toBeNull();
    expect(notionProvider.webhook!.sentAt!({ headers: {}, body: "{}" })).toBeNull();
  });

  it("tells which declared event it is", () => {
    const { sim } = simulated();
    const ev = (type: string) => notionWebhook.event(sim.webhook(type, A).rawBody);
    expect(ev("page.properties_updated")).toBe("issueChanged");
    expect(ev("page.created")).toBe("issueChanged");
    expect(ev("page.deleted")).toBe("issueChanged");
    expect(ev("comment.created")).toBe("commentAdded");
    expect(ev("database.schema_updated")).toBeNull();
    expect(notionWebhook.event("nope")).toBeNull();
  });
});
