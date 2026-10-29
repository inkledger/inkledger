import { describe, expect, it, vi } from "vitest";
import { instant, localDate, markdown, timeZone } from "@contracts/values";
import { toRichDoc } from "../core/richtext";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { statusHistoryConformance, trackerConformance } from "../conformance/suite";
import { asanaSimulator, type SimTask } from "./simulator";
import { asanaProvider, asanaWebhook, toAsanaHtml } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "198.51.100.7", family: 4 }]),
}));

const COLUMNS = { options: { columns: { "To do": "todo", Doing: "doing", Review: "doing", Done: "done", "Won't do": "cancelled" } } };

function simulated(o: { options?: unknown; token?: string; premium?: boolean; zone?: string } = {}) {
  const sim = asanaSimulator(undefined, { premium: o.premium });
  const web = sim.project("Website", { sections: ["To do", "Doing", "Review", "Done", "Won't do"] });
  sim.add("Login fails on Safari", { project: web, section: "To do", notes: "Steps", dueOn: "2026-11-05" });
  sim.add("Export to CSV", { project: web, section: "Doing", tags: ["bug"] });
  sim.add("Rate limit headers");
  // Someone else's, and one I wrote for someone else: not assigned to me.
  sim.add("Anna's", { project: web, assignee: sim.anna });
  sim.add("Delegated", { project: web, assignee: sim.anna, author: sim.me.gid });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 9,
    userId: 1,
    type: "asana" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: sim.me.gid,
    options: o.options ?? {},
    timeZone: timeZone(o.zone ?? "Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, web, conn, b: bindTracker(asanaProvider, conn) };
}

const urlOf = (sim: ReturnType<typeof asanaSimulator>, t: SimTask) => `${sim.web}/0/${t.memberships[0]?.project ?? "0"}/${t.gid}`;

trackerConformance("asana (simulated)", async () => {
  const { conn, sim } = simulated();
  return { provider: asanaProvider, conn, key: sim.keyOf(sim.tasks[0]), writable: true, url: urlOf(sim, sim.tasks[0]) };
});

trackerConformance("asana (simulated, sections as statuses)", async () => {
  const { conn, sim } = simulated(COLUMNS);
  return { provider: asanaProvider, conn, key: sim.keyOf(sim.tasks[0]), writable: true, url: urlOf(sim, sim.tasks[0]) };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const pass = (b: ReturnType<typeof simulated>["b"], since: Parameters<typeof b.listChanged>[1]["since"] = null) => readPass((q) => b.listChanged(meta(), q), since);
const ref = (t: SimTask) => ({ remoteId: t.gid, key: `ASANA-${t.gid}` });
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; rateLimit?: { retryAfterMs?: number; remaining?: number }; message: string });
const raw = (sim: ReturnType<typeof asanaSimulator>, path: string, init: { method?: string; data?: unknown } = {}) =>
  sim.fetch(`${sim.apiBase}${path}`, { method: init.method ?? "GET", headers: { Authorization: `Bearer ${sim.token}` }, ...(init.data === undefined ? {} : { body: JSON.stringify({ data: init.data }) }) });

describe("asana, tasks", () => {
  it("lists what is assigned to the user, keyed by gid, gids kept as strings past 2^53", async () => {
    const { b, sim } = simulated();
    const all = await pass(b);
    expect(all.items.map((i) => [i.key, i.title, i.status.name, i.status.category, i.container.kind])).toEqual([
      [`ASANA-${sim.tasks[0].gid}`, "Login fails on Safari", "Open", "todo", "project"],
      [`ASANA-${sim.tasks[1].gid}`, "Export to CSV", "Open", "todo", "project"],
      [`ASANA-${sim.tasks[2].gid}`, "Rate limit headers", "Open", "todo", "workspace"],
    ]);
    const [first, second] = all.items;
    expect(first).toMatchObject({ remoteId: sim.tasks[0].gid, due: "2026-11-05", container: { key: "Website", name: "Website" }, type: { id: "default_task", level: "standard" } });
    expect(first.assignees[0]).toMatchObject({ name: "Mario Rossi", avatarUrl: "https://s3.amazonaws.com/asana/photo-1.png" });
    expect(second.labels).toEqual(["bug"]);
    expect(first.remoteId.length).toBeGreaterThan(16);
    expect(String(Number(first.remoteId))).not.toBe(first.remoteId);
    expect(await b.description!(meta(), ref(sim.tasks[0]))).toEqual({ kind: "text", format: "html", text: "<body>Steps</body>" });
    expect(await b.description!(meta(), ref(sim.tasks[1]))).toBeNull();
  });

  it("asks for the fields it reads: Asana answers a bare record (gid, type, name) otherwise", async () => {
    const { sim } = simulated();
    const bare = (await (await raw(sim, `/tasks/${sim.tasks[0].gid}`)).json()) as { data: Record<string, unknown> };
    expect(Object.keys(bare.data).sort()).toEqual(["gid", "name", "resource_type"]);
    const full = (await (await raw(sim, `/tasks/${sim.tasks[0].gid}?opt_fields=completed,assignee.name`)).json()) as { data: { completed: boolean; assignee: Record<string, unknown> } };
    expect(full.data.completed).toBe(false);
    expect(Object.keys(full.data.assignee).sort()).toEqual(["gid", "name", "resource_type"]);
  });

  it("assignee is only taken with its workspace (400 otherwise)", async () => {
    const { sim } = simulated();
    expect((await raw(sim, "/tasks?assignee=me")).status).toBe(400);
  });

  it("reads a pass page by page (limit 50, an offset token), then only what changed since its checkpoint", async () => {
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

  it("an offset that Asana no longer takes is an invalid checkpoint, so the pass is read again", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 60; n++) sim.add(`Bulk ${n}`);
    const first = await b.listChanged(meta(), { since: null, page: null });
    expect(first.last).toBe(false);
    sim.expireOffsets();
    if (!first.last) expect(await errorOf(b.listChanged(meta(), { since: null, page: first.next }))).toMatchObject({ kind: "invalidCheckpoint" });
    expect((await pass(b)).items.length).toBe(63);
  });

  it("a first read keeps the tasks completed lately and the open ones; a later one every task touched since", async () => {
    const { b, sim } = simulated();
    const old = sim.add("Done long ago");
    old.completed = true;
    old.completedAt = Date.now() - 90 * 86_400_000;
    const recent = sim.add("Done this week");
    sim.outside.complete(recent);
    const first = await pass(b);
    expect(first.items.map((i) => i.title)).toContain("Done this week");
    expect(first.items.map((i) => i.title)).not.toContain("Done long ago");
    expect(first.items.find((i) => i.title === "Done this week")?.status).toMatchObject({ name: "Completed", category: "done" });
    sim.outside.comment(old, "still relevant");
    // The pass overlaps its checkpoint by a minute: what was just touched comes again, the untouched Anna's and the rest do not.
    const later = (await pass(b, first.checkpoint)).items.map((i) => i.title);
    expect(later).toContain("Done long ago");
    expect(later).not.toContain("Rate limit headers");
  });

  it("a due date with a time (due_at, UTC) falls on the user's day; due_on is a day as is", async () => {
    const { sim, b } = simulated();
    const late = sim.add("Late", { dueAt: "2026-11-05T23:30:00.000Z" });
    expect((await b.getIssue(meta(), ref(late)))?.due).toBe("2026-11-06");
    const rome = simulated({ zone: "America/Los_Angeles" });
    const t = rome.sim.add("Late", { dueAt: "2026-11-05T03:30:00.000Z" });
    expect((await rome.b.getIssue(meta(), ref(t)))?.due).toBe("2026-11-04");
    expect((await b.getIssue(meta(), ref(sim.tasks[0])))?.due).toBe("2026-11-05");
  });

  it("a subtask has no memberships: its container is its parent's project, and it is a sub", async () => {
    const { sim, b, web } = simulated();
    const sub = sim.add("Check Safari 17", { parent: sim.tasks[0] });
    const got = await b.getIssue(meta(), ref(sub));
    expect(got).toMatchObject({ type: { level: "sub" }, container: { remoteId: web.gid, kind: "project" }, parent: { remoteId: sim.tasks[0].gid } });
    expect(got?.status.name).toBe("Open");
    const listed = (await pass(b)).items.find((i) => i.remoteId === sub.gid);
    expect(listed?.container.remoteId).toBe(web.gid);
  });

  it("a task in several projects has several memberships: the first is its home", async () => {
    const { sim, b } = simulated(COLUMNS);
    const other = sim.project("Marketing", { sections: ["To do", "Done"] });
    sim.tasks[0].memberships.push({ project: other.gid, section: other.sections[1].gid });
    const got = await b.getIssue(meta(), ref(sim.tasks[0]));
    expect(got?.container.name).toBe("Website");
    expect(got?.status).toMatchObject({ name: "To do", source: { kind: "column" } });
  });

  it("a task moved to another project keeps its gid and key; a renamed project changes only the container", async () => {
    const { sim, b } = simulated();
    const first = await pass(b);
    const other = sim.project("Archive");
    sim.outside.moveToProject(sim.tasks[0], other);
    sim.outside.renameProject(other, "Archive 2026");
    const next = await pass(b, first.checkpoint);
    expect(next.items.map((i) => [i.remoteId, i.key, i.container.name, i.container.remoteId])).toEqual([[sim.tasks[0].gid, `ASANA-${sim.tasks[0].gid}`, "Archive 2026", other.gid]]);
  });

  it("a deleted task is a 404 and reads as not there; what the user cannot see is a 403, also not there", async () => {
    const { sim, b, web } = simulated();
    const t = sim.tasks[1];
    sim.outside.delete(t);
    expect(await b.getIssue(meta(), ref(t))).toBeNull();
    expect((await b.findIssue(meta(), { key: `ASANA-${t.gid}` })).kind).toBe("none");
    expect((await pass(b)).items.map((i) => i.title)).not.toContain("Export to CSV");
    expect(await errorOf(b.comments!.list(meta(), ref(t)))).toMatchObject({ kind: "notFound" });
    const hidden = sim.tasks[0];
    sim.tasks[0].assignee = sim.anna;
    sim.outside.access(web, false);
    expect((await raw(sim, `/tasks/${hidden.gid}`)).status).toBe(403);
    expect(await b.getIssue(meta(), ref(hidden))).toBeNull();
    expect((await b.findIssue(meta(), { key: `ASANA-${hidden.gid}` })).kind).toBe("none");
  });

  it("reads every workspace of the token, or only the one the options name", async () => {
    const { sim, b, conn } = simulated();
    const second = sim.addWorkspace("Side project");
    sim.add("Elsewhere", { workspace: second });
    expect((await pass(b)).items.map((i) => i.title)).toContain("Elsewhere");
    const only = bindTracker(asanaProvider, { ...conn, options: { workspace: sim.mainWorkspace } });
    expect((await pass(only)).items.map((i) => i.title)).not.toContain("Elsewhere");
    const wrong = bindTracker(asanaProvider, { ...conn, options: { workspace: "42" } });
    expect(await errorOf(pass(wrong))).toMatchObject({ kind: "invalid" });
  });

  it("searches the user's tasks on a paid plan (no paging: cut at the limit), through typeahead on a free one (other people's tasks filtered out)", async () => {
    const paid = simulated();
    const r = await paid.b.searchText!(meta(), "export", 10);
    expect(r.items.map((i) => i.title)).toEqual(["Export to CSV"]);
    expect(r.complete).toBe(true);
    const cut = await paid.b.searchText!(meta(), "a", 1);
    expect(cut.items.length).toBe(1);
    expect(cut.complete).toBe(false);
    const free = simulated({ premium: false });
    expect((await raw(free.sim, `/workspaces/${free.sim.mainWorkspace}/tasks/search?text=x`)).status).toBe(402);
    const f = await free.b.searchText!(meta(), "a", 10);
    // "Anna's" matches "a" in the workspace but is not the user's.
    expect(f.items.map((i) => i.title).sort()).toEqual(["Login fails on Safari", "Rate limit headers"]);
  });
});

describe("asana, keys and links", () => {
  it("reads keys, and the links of the web app (old and new forms, with a focus suffix)", () => {
    const { b } = simulated();
    expect(b.normalizeKey("asana-1209000000000000042")).toBe("ASANA-1209000000000000042");
    expect(b.normalizeKey("1209000000000000042")).toBeNull();
    expect(b.normalizeKey("ASANA-x")).toBeNull();
    expect(b.parseRef("https://app.asana.com/0/1209000000000000001/1209000000000000042")).toEqual({ key: "ASANA-1209000000000000042", remoteId: "1209000000000000042" });
    expect(b.parseRef("https://app.asana.com/0/1209000000000000001/1209000000000000042/f")).toMatchObject({ remoteId: "1209000000000000042" });
    expect(b.parseRef("https://app.asana.com/0/0/1209000000000000042")).toMatchObject({ remoteId: "1209000000000000042" });
    expect(b.parseRef("https://app.asana.com/1/12/project/34/task/1209000000000000042?focus=true")).toMatchObject({ remoteId: "1209000000000000042" });
    expect(b.parseRef("https://app.asana.com/1/12/task/1209000000000000042")).toMatchObject({ remoteId: "1209000000000000042" });
    expect(b.parseRef("https://app.asana.com/0/1209000000000000001/list")).toBeNull();
    expect(b.parseRef("https://asana.example/0/1/2")).toBeNull();
  });

  it("finds a task by a pasted link", async () => {
    const { b, sim } = simulated();
    const handle = b.parseRef(urlOf(sim, sim.tasks[2]));
    const found = handle && (await b.findIssue(meta(), handle));
    expect(found && found.kind === "found" && found.issue.title).toBe("Rate limit headers");
  });
});

describe("asana, workflow", () => {
  it("completes and reopens: Complete and Reopen, open / completed as the only source by default", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.tasks[0]);
    expect((await b.transitions!.list!(meta(), r)).map((t) => [t.name, t.to.category])).toEqual([["Complete", "done"]]);
    const done = await b.transitions!.apply!(meta(), r, "complete", {});
    expect(done?.status).toMatchObject({ name: "Completed", category: "done", categoryOrigin: { by: "native" } });
    expect((await b.transitions!.list!(meta(), r)).map((t) => [t.name, t.to.name, t.to.category])).toEqual([["Reopen", "Open", "todo"]]);
    expect((await b.transitions!.apply!(meta(), r, "reopen", {}))?.status.name).toBe("Open");
    expect((await b.probe(meta())).activeSources.map((s) => s.kind)).toEqual(["boolean"]);
    expect((await b.statuses!(meta(), { kind: "boolean", transitions: "direct", reasons: false, ref: { kind: "boolean" }, name: "Open / completed" })).map((s) => s.name)).toEqual(["Open", "Completed"]);
  });

  it("sections give statuses whose categories come from the connection's options, never from the names", async () => {
    const { b, sim, web } = simulated(COLUMNS);
    const t = sim.tasks[0];
    const r = ref(t);
    expect((await b.getIssue(meta(), r))?.status).toMatchObject({ name: "To do", category: "todo", categoryOrigin: { by: "mapping" }, source: { kind: "column", boardRemoteId: web.gid } });
    sim.outside.moveToSection(t, web, "Review");
    expect((await b.getIssue(meta(), r))?.status).toMatchObject({ name: "Review", category: "doing" });
    const ways = await b.transitions!.list!(meta(), r);
    expect(ways.map((w) => [w.name, w.to.category])).toEqual([
      ["Move to To do", "todo"],
      ["Move to Doing", "doing"],
      ["Move to Done", "done"],
      ["Move to Won't do", "cancelled"],
      ["Complete", "done"],
    ]);
    const moved = await b.transitions!.apply!(meta(), r, ways[3].id, {});
    expect(moved?.status).toMatchObject({ name: "Won't do", category: "cancelled" });
    expect(t.memberships).toHaveLength(1);
    // Completed is completed whatever its section says.
    expect((await b.transitions!.apply!(meta(), r, "complete", {}))?.status).toMatchObject({ name: "Completed", category: "done" });
    const probe = await b.probe(meta());
    expect(probe.activeSources.map((s) => s.kind)).toEqual(["boolean", "column"]);
    const source = probe.activeSources[1];
    expect((await b.statuses!(meta(), source)).map((s) => [s.name, s.category, s.order])).toEqual([
      ["To do", "todo", 0],
      ["Doing", "doing", 1],
      ["Review", "doing", 2],
      ["Done", "done", 3],
      ["Won't do", "cancelled", 4],
    ]);
  });

  it("a section not named in the options means nothing, and a task in a project with no sections reads Open", async () => {
    const { b, sim, web } = simulated({ options: { columns: { Doing: "doing" } } });
    expect((await b.getIssue(meta(), ref(sim.tasks[0])))?.status.name).toBe("Open");
    expect((await b.getIssue(meta(), ref(sim.tasks[1])))?.status.name).toBe("Doing");
    const bare = sim.project("Bare");
    const t = sim.add("In a list view", { project: bare });
    expect((await b.getIssue(meta(), ref(t)))?.status.name).toBe("Open");
    expect((await b.transitions!.list!(meta(), ref(t))).map((w) => w.id)).toEqual(["complete"]);
    expect((await b.transitions!.list!(meta(), ref(sim.tasks[0]))).map((w) => w.name)).toEqual(["Move to Doing", "Complete"]);
    expect(web.sections.length).toBe(5);
  });

  it("a section renamed on Asana keeps its id, a task moved there by hand reads the new name", async () => {
    const { b, sim, web } = simulated({ options: { columns: { Started: "doing", "To do": "todo" } } });
    const r = ref(sim.tasks[1]);
    expect((await b.getIssue(meta(), r))?.status.name).toBe("Open");
    const id = web.sections[1].gid;
    sim.outside.renameSection(web, "Doing", "Started");
    expect((await b.getIssue(meta(), r))?.status).toMatchObject({ id, name: "Started", category: "doing" });
  });

  it("addTask on a section of another project would put the task in that project: only its own project's sections are offered", async () => {
    const { b, sim } = simulated(COLUMNS);
    const other = sim.project("Marketing", { sections: ["Done"] });
    const t = sim.tasks[0];
    const raw1 = await raw(sim, `/sections/${other.sections[0].gid}/addTask`, { method: "POST", data: { task: t.gid } });
    expect(raw1.status).toBe(200);
    expect(t.memberships.length).toBe(2);
    t.memberships = t.memberships.slice(0, 1);
    const ways = await b.transitions!.list!(meta(), ref(t));
    expect(ways.every((w) => !w.to.id || w.to.source.kind !== "column" || w.to.source.boardRemoteId === t.memberships[0].project)).toBe(true);
    expect(await errorOf(b.transitions!.apply!(meta(), ref(t), `section:${other.sections[0].gid}`, {}))).toMatchObject({ kind: "invalid" });
    expect(t.memberships.length).toBe(1);
  });

  it("refuses options it can't read", () => {
    expect(() => asanaProvider.parseOptions({ workspace: "acme" })).toThrow(/workspace/);
    expect(() => asanaProvider.parseOptions({ columns: { x: "wip" } })).toThrow();
    expect(asanaProvider.parseOptions(undefined)).toEqual({ workspace: null, columns: {} });
    expect(asanaProvider.parseOptions({ columns: { " Doing ": "doing" } }).columns).toEqual({ doing: "doing" });
  });
});

describe("asana, comments", () => {
  it("leaves system stories out, reads HTML (wrapped in <body>) and writes it", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const r = ref(t);
    sim.outside.comment(t, "Reproduced on <strong>iOS</strong> 18");
    await b.transitions!.apply!(meta(), r, "complete", {});
    expect(t.stories.some((s) => s.type === "system")).toBe(true);
    const added = await b.comments!.add!(meta(), r, markdown("Looks **fixed**, see [the fix](https://example.org/pr/1)"), { idempotencyKey: "c1" });
    expect(added.comment?.body).toEqual({ kind: "text", format: "html", text: '<body>Looks <strong>fixed</strong>, see <a href="https://example.org/pr/1">the fix</a></body>' });
    expect(added.warnings).toEqual([]);
    const list = await b.comments!.list(meta(), r);
    expect(list.map((c) => [c.author.name, c.body.kind === "text" ? c.body.text : ""])).toEqual([
      ["Anna Bianchi", "<body>Reproduced on <strong>iOS</strong> 18</body>"],
      ["Mario Rossi", '<body>Looks <strong>fixed</strong>, see <a href="https://example.org/pr/1">the fix</a></body>'],
    ]);
    const doc = toRichDoc(list[0].body);
    expect(doc.blocks.length).toBeGreaterThan(0);
  });

  it("Asana refuses html_text outside its small set of tags (no <p>, no headings): Markdown is written without them, and what is lost is said", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.tasks[0]);
    const direct = await raw(sim, `/tasks/${sim.tasks[0].gid}/stories`, { method: "POST", data: { html_text: "<body><p>hi</p></body>" } });
    expect(direct.status).toBe(400);
    expect((await raw(sim, `/tasks/${sim.tasks[0].gid}/stories`, { method: "POST", data: { html_text: "hi" } })).status).toBe(400);
    const md = "# Title\n\n- one\n- **two**\n\n1. a\n2. b\n\n> quoted\n\n```\ncode & <b>\n```\n\n| a | b |\n|---|---|\n\n![img](https://example.org/i.png)";
    const added = await b.comments!.add!(meta(), r, markdown(md), { idempotencyKey: "c2" });
    expect(added.comment).not.toBeNull();
    expect(added.warnings.map((w) => w.feature).sort()).toEqual(["codeBlock", "heading", "image", "quote", "table"]);
    expect(toAsanaHtml("- a\n- b\n\ntext").html).toBe("<body><ul><li>a</li><li>b</li></ul>\ntext</body>");
    expect(toAsanaHtml("a & b < c *x* `y*z*`").html).toBe("<body>a &amp; b &lt; c <em>x</em> <code>y*z*</code></body>");
  });
});

describe("asana, watching and history", () => {
  it("following twice and unfollowing twice are successes", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.tasks[0]);
    await b.watch!(meta(), r, true);
    await b.watch!(meta(), r, true);
    expect(sim.tasks[0].followers.has(sim.me.gid)).toBe(true);
    await b.watch!(meta(), r, false);
    await b.watch!(meta(), r, false);
    expect(sim.tasks[0].followers.has(sim.me.gid)).toBe(false);
  });

  it("history turns system stories into changes in time order; stories it does not know stay as they are", async () => {
    const { b, sim, web } = simulated();
    const t = sim.tasks[0];
    sim.outside.moveToSection(t, web, "Doing");
    sim.outside.complete(t);
    sim.outside.retitle(t, "Renamed");
    sim.outside.due(t, "2026-12-01");
    sim.outside.assign(t, sim.anna);
    sim.outside.comment(t, "not history");
    t.stories.push({ gid: "s-odd", type: "system", subtype: "added_to_tag", created: Date.now() + 10, by: sim.anna, html: null, text: "added the tag urgent" });
    const h = await b.history!(meta(), ref(t));
    expect(h.map((c) => [c.field.id ?? c.field.name, c.from.map((v) => v.text), c.to.map((v) => v.text)])).toEqual([
      ["section", ["To do"], ["Doing"]],
      ["completed", ["No"], ["Yes"]],
      ["name", ["Login fails on Safari"], ["Renamed"]],
      ["due_on", ["2026-11-05"], ["2026-12-01"]],
      ["assignee", [], ["Anna Bianchi"]],
      ["added_to_tag", [], ["added the tag urgent"]],
    ]);
    expect(h[0].actor).toMatchObject({ name: "Anna Bianchi" });
    expect(h.map((c) => c.at)).toEqual([...h.map((c) => c.at)].sort((a, c) => a - c));
  });
});

describe("asana, time", () => {
  const date = (d: string) => ({ kind: "date" as const, date: localDate(d), seconds: 0 });

  it("logs a day's time in whole minutes (rounded, at least one), billable and with a category, and reads it back", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.tasks[0]);
    const cat = sim.category("Design");
    const made = await b.worklogs!.create!(meta(), r, { time: { ...date("2026-10-14"), seconds: 5430 }, comment: "debugging", billable: true, activityId: cat.gid }, { idempotencyKey: "k1" });
    // 5430 s is 90.5 minutes: 91 are kept.
    expect(made).toMatchObject({ span: { kind: "date", date: "2026-10-14", seconds: 91 * 60 }, comment: "debugging", billable: true, activity: { id: cat.gid, name: "Design" }, approval: "draft", editable: { update: true, delete: true }, issue: { remoteId: sim.tasks[0].gid } });
    const tiny = await b.worklogs!.create!(meta(), r, { time: { ...date("2026-10-14"), seconds: 10 }, comment: "" }, { idempotencyKey: "k2" });
    expect(tiny.span.seconds).toBe(60);
    expect(tiny.billable).toBeNull();
    const changed = await b.worklogs!.update!(meta(), r, made.remoteId, { time: { ...date("2026-10-15"), seconds: 1800 }, comment: "changed", billable: false }, {});
    expect(changed).toMatchObject({ span: { date: "2026-10-15", seconds: 1800 }, billable: false, activity: { id: cat.gid } });
    expect((await b.worklogs!.list(meta(), r)).map((w) => w.remoteId).sort()).toEqual([made.remoteId, tiny.remoteId].sort());
    expect((await b.worklogs!.get!(meta(), r, made.remoteId))?.comment).toBe("changed");
    expect((await b.getIssue(meta(), r))?.spentSeconds).toBe(31 * 60);
    expect(b.worklogs!.changed).toBeUndefined();
    expect(b.capabilities.time).toMatchObject({ entries: { feed: { kind: "none" }, reconcile: { kind: "period" } } });
  });

  it("deleting twice is a success; an entry of someone else is read, never editable; an approved or submitted one is locked", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const r = ref(t);
    const mine = sim.entry(t, { minutes: 30, enteredOn: "2026-10-14" });
    const theirs = sim.entry(t, { minutes: 15, enteredOn: "2026-10-14", user: sim.anna });
    const locked = sim.entry(t, { minutes: 45, enteredOn: "2026-10-13" });
    sim.outside.approve(locked);
    const list = await b.worklogs!.list(meta(), r);
    const by = (id: string) => list.find((w) => w.remoteId === id)!;
    expect(by(theirs.gid)).toMatchObject({ authorRemoteId: sim.anna, editable: { update: false, delete: false } });
    expect(by(locked.gid)).toMatchObject({ approval: "approved", locked: { cause: "approved" }, editable: { update: false, delete: false } });
    sim.outside.submit(mine);
    expect((await b.worklogs!.list(meta(), r)).find((w) => w.remoteId === mine.gid)).toMatchObject({ locked: { cause: "submitted" } });
    expect(await errorOf(b.worklogs!.update!(meta(), r, locked.gid, { time: { ...date("2026-10-13"), seconds: 600 }, comment: "x" }, {}))).toMatchObject({ kind: "forbidden" });
    expect(await errorOf(b.worklogs!.delete!(meta(), r, theirs.gid, {}))).toMatchObject({ kind: "forbidden" });
    mine.approval = "draft";
    await b.worklogs!.delete!(meta(), r, mine.gid, {});
    await b.worklogs!.delete!(meta(), r, mine.gid, {});
    expect(sim.entries.some((e) => e.gid === mine.gid)).toBe(false);
    expect(await b.worklogs!.get!(meta(), r, mine.gid)).toBeNull();
  });

  it("offers the time tracking categories of the workspace, and refuses a category that is not one", async () => {
    const { b, sim } = simulated();
    sim.category("Design");
    sim.category("Meetings");
    sim.category("Elsewhere", sim.addWorkspace("Side"));
    const got = await b.worklogs!.activities!(meta(), {}, 10);
    expect(got.items.map((i) => i.name).sort()).toEqual(["Design", "Elsewhere", "Meetings"]);
    expect((await b.worklogs!.activities!(meta(), {}, 1)).complete).toBe(false);
    expect(await errorOf(b.worklogs!.create!(meta(), ref(sim.tasks[0]), { time: { ...date("2026-10-14"), seconds: 600 }, comment: "", activityId: "999" }, { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid" });
  });

  it("a session is refused: Asana keeps a day", async () => {
    const { b, sim } = simulated();
    const err = await errorOf(b.worklogs!.create!(meta(), ref(sim.tasks[0]), { time: { kind: "session", start: instant(Date.UTC(2026, 9, 14, 8)), seconds: 600 }, comment: "" }, { idempotencyKey: "k" }));
    expect(err).toMatchObject({ kind: "invalid" });
  });
});

describe("asana, webhooks", () => {
  const secret = "hook-secret-from-handshake";
  const events = [{ action: "changed" as const, resource: { gid: "1", resource_type: "task" } }];

  it("accepts a delivery signed with the handshake secret and refuses any other", () => {
    const { sim } = simulated();
    const d = sim.webhook(events, { secret });
    expect(asanaWebhook.verify(d.headers, d.rawBody, secret)).toBe(true);
    expect(asanaProvider.webhook!.verify({ headers: d.headers, body: d.rawBody }, secret)).toBe(true);
    const wrong = sim.webhook(events, { secret, signedWith: "other" });
    expect(asanaWebhook.verify(wrong.headers, wrong.rawBody, secret)).toBe(false);
    expect(asanaWebhook.verify(d.headers, d.rawBody.replace("changed", "deleted"), secret)).toBe(false);
    expect(asanaWebhook.verify({}, d.rawBody, secret)).toBe(false);
    expect(asanaWebhook.verify({ "x-hook-signature": "zz" }, d.rawBody, secret)).toBe(false);
    expect(asanaWebhook.verify(d.headers, d.rawBody, "")).toBe(false);
  });

  it("answers the handshake with the secret it was sent, has no delivery id, and dates a delivery by its latest event", () => {
    const { sim } = simulated();
    const h = sim.handshake(secret);
    expect(asanaWebhook.handshake(h.headers)).toBe(secret);
    expect(asanaWebhook.handshake({})).toBeNull();
    const d = sim.webhook(events, { secret, ageMs: 5000 });
    expect(asanaProvider.webhook!.deliveryId({ headers: d.headers, body: d.rawBody })).toBeNull();
    const at = asanaWebhook.sentAt(d.rawBody)!;
    expect(Date.now() - at).toBeGreaterThanOrEqual(5000);
    expect(asanaWebhook.sentAt(JSON.stringify({ events: [] }))).toBeNull();
    expect(asanaWebhook.sentAt("not json")).toBeNull();
  });

  it("names the declared events a delivery holds", () => {
    const body = (e: unknown[]) => JSON.stringify({ events: e });
    expect(asanaWebhook.events(body([{ action: "changed", resource: { resource_type: "task" } }, { action: "deleted", resource: { resource_type: "task" } }]))).toEqual(["issueChanged", "issueRemoved"]);
    expect(asanaWebhook.events(body([{ action: "added", resource: { resource_type: "story", resource_subtype: "comment_added" } }]))).toEqual(["commentAdded"]);
    expect(asanaWebhook.events(body([{ action: "added", resource: { resource_type: "time_tracking_entry" } }]))).toEqual(["worklogChanged"]);
    expect(asanaWebhook.events(body([{ action: "changed", resource: { resource_type: "project" } }]))).toEqual([]);
    expect(asanaWebhook.events(body([]))).toEqual([]);
    expect(asanaWebhook.events("nope")).toEqual([]);
  });
});

describe("asana, errors and limits", () => {
  it("a bad token is auth (401)", async () => {
    const { b } = simulated({ token: "wrong" });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "auth" });
  });

  it("a revoked token is auth on every call", async () => {
    const { b, sim } = simulated();
    expect((await b.verify(meta())).remoteId).toBe(sim.me.gid);
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

  it("a missing task is notFound where an operation needs it, null where a lookup asks; payment required is forbidden", async () => {
    const { b } = simulated();
    const ghost = { remoteId: "1209999999999999999", key: "ASANA-1209999999999999999" };
    expect(await b.getIssue(meta(), ghost)).toBeNull();
    expect(await errorOf(b.transitions!.list!(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.watch!(meta(), ghost, true))).toMatchObject({ kind: "notFound" });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors: [{ message: "Time tracking requires a paid plan" }] }), { status: 402 }));
    expect(await errorOf(b.worklogs!.list(meta(), { remoteId: "1", key: "ASANA-1" }))).toMatchObject({ kind: "forbidden", message: expect.stringContaining("paid plan") });
  });

  it("knows who the token belongs to; Asana gives no budget figure", async () => {
    const { b, sim } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: sim.me.gid, name: "Mario Rossi", email: "mario@acme.example" });
    expect((await b.probe(meta())).rateLimit).toBeUndefined();
  });
});

statusHistoryConformance("asana (simulated, sections as statuses)", async () => {
  const { b, sim, web } = simulated(COLUMNS);
  const t = sim.tasks[0];
  return { b, ref: ref(t), moveTwice: () => (sim.outside.moveToSection(t, web, "Doing"), sim.outside.moveToSection(t, web, "Review")) };
});

describe("asana, status history", () => {
  it("a composite status is replayed as the app computes it", async () => {
    const { b, sim, web } = simulated(COLUMNS);
    const t = sim.tasks[0];
    sim.outside.moveToSection(t, web, "Doing");
    sim.outside.complete(t);
    sim.outside.reopen(t);
    sim.outside.moveToSection(t, web, "Review");
    const steps = await b.statusHistory!(meta(), ref(t));
    expect(steps.map((s) => [s.from?.name, s.to.name])).toEqual([
      ["To do", "Doing"],
      ["Doing", "Completed"],
      ["Completed", "Doing"],
      ["Doing", "Review"],
    ]);
  });

  it("a task in several projects has no readable status history", async () => {
    const { b, sim } = simulated(COLUMNS);
    const other = sim.project("Ops", { sections: ["Doing"] });
    const t = sim.tasks[0];
    sim.outside.moveToSection(t, other, "Doing");
    await expect(b.statusHistory!(meta(), ref(t))).rejects.toMatchObject({ kind: "incompatible" });
  });
});
