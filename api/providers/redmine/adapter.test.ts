import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { markdown, timeZone } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import { redmineSimulator, STATUS } from "./simulator";
import { categoryOf, redmineDeliveryId, redmineProvider, redmineSentAt, verifyRedmineWebhook } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

// The clock stands still (Date only), so entries dated "2026-10-14" are inside the 30-day window, and updates share a second.
const NOW = Date.parse("2026-10-21T10:00:00Z");
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

function simulated(o: { apiBase?: string; token?: string } = {}) {
  const sim = redmineSimulator(o.apiBase);
  sim.add("acme-web", "Login fails on Safari", { description: "h1. Steps\n\n* open\n* *fail*", due: "2026-11-05", start: "2026-10-01", estimated: 4 });
  sim.add("acme-web", "Export to CSV");
  sim.add("acme-platform", "Rate limit headers", { tracker: 2, priority: 5 });
  // Not assigned to me, and one I wrote for someone else.
  sim.add("acme-web", "Anna's", { assignee: 78 });
  sim.add("acme-web", "Delegated", { assignee: 78, author: sim.me.id });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 7,
    userId: 1,
    type: "redmine" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: String(sim.me.id),
    options: {},
    timeZone: timeZone("Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, conn, b: bindTracker(redmineProvider, conn) };
}

trackerConformance("redmine (simulated)", async () => {
  const { conn, sim } = simulated();
  return { provider: redmineProvider, conn, key: sim.keyOf(sim.issues[0]), writable: true, url: `https://redmine.example.com/issues/${sim.issues[0].id}` };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const pass = (b: ReturnType<typeof simulated>["b"], since: Parameters<typeof b.listChanged>[1]["since"] = null) => readPass((q) => b.listChanged(meta(), q), since);
const feed = (b: ReturnType<typeof simulated>["b"], since: Parameters<typeof b.listChanged>[1]["since"] = null) => readPass((q) => b.worklogs!.changed!(meta(), q), since);
const ref = (i: { id: number }) => ({ remoteId: String(i.id), key: `#${i.id}` });
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; rateLimit?: { retryAfterMs?: number; remaining?: number }; message: string });
const input = (seconds: number, d = "2026-10-14") => ({ time: { kind: "date" as const, date: d as never, seconds }, comment: "work" });

describe("redmine, issues", () => {
  it("lists what is assigned to the user, closed ones too, keyed #id with the project's identifier", async () => {
    const { b, sim } = simulated();
    sim.outside.status(sim.issues[1], STATUS.closed);
    const all = await pass(b);
    expect(all.items.map((i) => [i.key, i.container.key, i.status.name, i.status.category])).toEqual([
      [`#${sim.issues[0].id}`, "acme-web", "New", "todo"],
      [`#${sim.issues[2].id}`, "acme-platform", "New", "todo"],
      [`#${sim.issues[1].id}`, "acme-web", "Closed", "done"],
    ]);
    const [first, third] = all.items;
    expect(first).toMatchObject({ title: "Login fails on Safari", due: "2026-11-05", estimateSeconds: 14_400, spentSeconds: 0, type: { name: "Bug", level: "standard" }, url: `https://redmine.example.com/issues/${sim.issues[0].id}` });
    expect(first.assignees[0]).toMatchObject({ name: "Mario Rossi" });
    expect(third).toMatchObject({ priority: { name: "High", rank: null }, type: { name: "Feature" } });
    expect(first.status.categoryOrigin).toEqual({ by: "native" });
    expect(await b.description!(meta(), ref(sim.issues[0]))).toEqual({ kind: "text", format: "textile", text: "h1. Steps\n\n* open\n* *fail*" });
    expect(await b.description!(meta(), ref(sim.issues[1]))).toBeNull();
  });

  it("without status_id Redmine lists open issues only: the adapter asks for all", async () => {
    const { b, sim } = simulated();
    sim.outside.status(sim.issues[0], STATUS.rejected);
    const raw = await (await sim.fetch(`${sim.apiBase}/issues.json?assigned_to_id=me`, { headers: { "X-Redmine-API-Key": sim.token } })).json();
    expect((raw as { issues: unknown[] }).issues.length).toBe(2);
    expect((await pass(b)).items.find((i) => i.remoteId === String(sim.issues[0].id))?.status).toMatchObject({ name: "Rejected", category: "cancelled" });
  });

  it("the issue's status has no is_closed: it comes from the status list, and Resolved is open", async () => {
    const { b, sim } = simulated();
    const raw = await (await sim.fetch(`${sim.apiBase}/issues/${sim.issues[0].id}.json`, { headers: { "X-Redmine-API-Key": sim.token } })).json();
    expect((raw as { issue: { status: object } }).issue.status).not.toHaveProperty("is_closed");
    sim.outside.status(sim.issues[0], STATUS.resolved);
    expect((await b.getIssue(meta(), ref(sim.issues[0])))?.status).toMatchObject({ name: "Resolved", category: "doing" });
    expect(categoryOf("Chiuso", true)).toBe("done");
    expect(categoryOf("Rifiutato", true)).toBe("cancelled");
    expect(categoryOf("In corso", false)).toBe("doing");
  });

  it("reads a pass page by page (limit tops out at 100), then only what changed since its checkpoint", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 130; n++) sim.add("acme-bulk", `Bulk ${n}`);
    const all = await pass(b);
    expect(all.pages).toBeGreaterThanOrEqual(2);
    expect(all.items.length).toBe(133);
    expect(new Set(all.items.map((i) => i.remoteId)).size).toBe(133);
    expect(all.checkpoint).not.toBeNull();
    const quiet = await pass(b, all.checkpoint);
    // Only the overlap minute before the last change: not the whole list.
    expect(quiet.items.length).toBeLessThan(all.items.length);
    sim.outside.retitle(sim.issues[0], "Login fails on Safari 18");
    const again = await pass(b, all.checkpoint);
    expect(again.items.map((i) => i.title)).toContain("Login fails on Safari 18");
  });

  it("updated_on is to the second: a change in the same second as the last one read is not lost", async () => {
    const { b, sim } = simulated();
    const first = await pass(b);
    // The clock is frozen: these land in one second, after the checkpoint's last change was stamped.
    sim.outside.retitle(sim.issues[1], "Export to CSV and PDF");
    const mid = await pass(b, first.checkpoint);
    expect(mid.items.map((i) => i.title)).toContain("Export to CSV and PDF");
    sim.outside.retitle(sim.issues[2], "Rate limits, again");
    const next = await pass(b, mid.checkpoint);
    expect(next.items.map((i) => i.title)).toContain("Rate limits, again");
    // A time filter is exact to the second, a bare date is the start of its UTC day (the simulator holds Redmine's rule).
    const bare = await (await sim.fetch(`${sim.apiBase}/issues.json?status_id=*&updated_on=%3E%3D2026-10-21`, { headers: { "X-Redmine-API-Key": sim.token } })).json();
    expect((bare as { total_count: number }).total_count).toBeGreaterThan(0);
  });

  it("a project move keeps the issue's id: the container changes, the identity does not", async () => {
    const { b, sim } = simulated();
    const first = await pass(b);
    const i = sim.issues[0];
    sim.outside.moveToProject(i, "acme-platform");
    const after = await pass(b, first.checkpoint);
    const moved = after.items.find((x) => x.remoteId === String(i.id));
    expect(moved).toMatchObject({ key: `#${i.id}`, container: { key: "acme-platform" } });
    expect(after.gone).toEqual([]);
    expect((await b.findIssue(meta(), { key: `#${i.id}` })).kind).toBe("found");
  });

  it("an issue the user may not see is a 403, read as not there by lookups and forbidden by operations", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    sim.outside.access("acme-web", false);
    expect(await b.getIssue(meta(), ref(i))).toBeNull();
    expect((await b.findIssue(meta(), { key: `#${i.id}` })).kind).toBe("none");
    expect((await pass(b)).items.map((x) => x.key)).toEqual([`#${sim.issues[2].id}`]);
    expect(await errorOf(b.comments!.list(meta(), ref(i)))).toMatchObject({ kind: "forbidden" });
  });

  it("the issue names its project by id and name only: the identifier is read from the project list, and an unknown project falls back to its id", async () => {
    const { b, sim } = simulated();
    await pass(b);
    const late = sim.add("acme-new", "Late project");
    const project = sim.projects.get(late.projectId)!;
    expect((await b.getIssue(meta(), ref(late)))?.container).toMatchObject({ remoteId: String(project.id), key: String(project.id), name: "Acme new" });
    vi.setSystemTime(NOW + 31_000);
    expect((await b.getIssue(meta(), ref(late)))?.container.key).toBe("acme-new");
    vi.setSystemTime(NOW);
  });

  it("subprojects name their parent as the group", async () => {
    const { b, sim } = simulated();
    sim.project("acme-web-mobile", { parent: "acme-web" });
    const i = sim.add("acme-web-mobile", "Sub");
    expect((await b.getIssue(meta(), ref(i)))?.container).toMatchObject({ key: "acme-web-mobile", group: "Acme web" });
  });

  it("a subtask knows its parent", async () => {
    const { b, sim } = simulated();
    const child = sim.add("acme-web", "Child", { parent: sim.issues[0] });
    const got = await b.getIssue(meta(), ref(child));
    expect(got).toMatchObject({ parent: { remoteId: String(sim.issues[0].id), key: `#${sim.issues[0].id}` }, type: { level: "sub" } });
  });

  it("searches only the user's own (assigned or written), in subject or description, complete when nothing was cut", async () => {
    const { b, sim } = simulated();
    const r = await b.searchText!(meta(), "export", 10);
    expect(r.items.map((i) => i.title)).toEqual(["Export to CSV"]);
    expect(r.complete).toBe(true);
    expect((await b.searchText!(meta(), "delegated", 10)).items.map((i) => i.title)).toEqual(["Delegated"]);
    expect((await b.searchText!(meta(), "fail", 10)).items.map((i) => i.title)).toEqual(["Login fails on Safari"]);
    sim.add("acme-web", "Someone else's thing", { assignee: 78, author: 78 });
    expect((await b.searchText!(meta(), "someone", 10)).items).toEqual([]);
    const cut = await b.searchText!(meta(), "a", 1);
    expect(cut.items.length).toBe(1);
    expect(cut.complete).toBe(false);
  });

  it("reads a custom field by its id", async () => {
    const { b, sim } = simulated();
    const i = sim.add("acme-web", "With field", { custom: [{ id: 3, name: "Customer", value: "ACME" }] });
    expect((await b.getIssue(meta(), ref(i)))?.fields).toEqual({ "3": "ACME" });
  });
});

describe("redmine, keys and links", () => {
  it("reads #id and the links of the web UI (with a sub-URI too), and refuses other things", () => {
    const { b } = simulated();
    expect(b.normalizeKey("#123")).toBe("#123");
    expect(b.normalizeKey(" #0123 ")).toBe("#123");
    expect(b.normalizeKey("123")).toBeNull();
    expect(b.normalizeKey("PROJ-1")).toBeNull();
    expect(b.parseRef("https://redmine.example.com/issues/12")).toEqual({ key: "#12" });
    expect(b.parseRef("https://redmine.example.com/issues/12#note-4")).toEqual({ key: "#12" });
    expect(b.parseRef("https://redmine.example.com/issues/12.json")).toEqual({ key: "#12" });
    expect(b.parseRef("https://redmine.example.com/issues/12/time_entries/new")).toEqual({ key: "#12" });
    expect(b.parseRef("https://redmine.example.com/projects/acme/issues")).toBeNull();
    expect(b.parseRef("https://redmine.example.org/issues/12")).toBeNull();
    const prefixed = bindTracker(redmineProvider, { ...simulated().conn, baseUrl: "https://example.org/redmine" });
    expect(prefixed.parseRef("https://example.org/redmine/issues/3")).toEqual({ key: "#3" });
    expect(prefixed.parseRef("https://example.org/other/issues/3")).toBeNull();
  });

  it("an id is unique on the server: a key and an id that disagree name nothing", async () => {
    const { b, sim } = simulated();
    const [a, c] = sim.issues;
    expect((await b.findIssue(meta(), { remoteId: String(a.id), key: `#${c.id}` })).kind).toBe("none");
    const found = await b.findIssue(meta(), { remoteId: String(a.id), key: `#${a.id}` });
    expect(found.kind).toBe("found");
    const link = b.parseRef(`https://redmine.example.com/issues/${c.id}`);
    const byLink = link && (await b.findIssue(meta(), link));
    expect(byLink && byLink.kind === "found" && byLink.issue.title).toBe("Export to CSV");
  });
});

describe("redmine, workflow", () => {
  it("offers the allowed statuses (not the current one) with categories from is_closed and names, and moves along one", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.issues[0]);
    const ways = await b.transitions!.list!(meta(), r);
    expect(ways.map((t) => [t.name, t.to.category])).toEqual([
      ["In Progress", "doing"],
      ["Resolved", "doing"],
      ["Feedback", "doing"],
      ["Closed", "done"],
      ["Rejected", "cancelled"],
    ]);
    expect(ways.every((t) => t.remoteUrl === `https://redmine.example.com/issues/${sim.issues[0].id}`)).toBe(true);
    const done = await b.transitions!.apply!(meta(), r, "status:2", {});
    expect(done?.status).toMatchObject({ name: "In Progress", category: "doing" });
    expect((await b.transitions!.list!(meta(), r)).map((t) => t.name)).not.toContain("In Progress");
    expect((await b.transitions!.apply!(meta(), r, "status:5", {}))?.statusChangedAt).not.toBeNull();
    expect(await errorOf(b.transitions!.apply!(meta(), r, "bogus", {}))).toMatchObject({ kind: "invalid" });
  });

  it("a workflow's own list decides, and a move it does not allow, or that demands a field, is refused with Redmine's words", async () => {
    const { b, sim } = simulated();
    const i = sim.add("acme-web", "Unassigned", { assignee: null });
    sim.workflow.set(STATUS.new, [STATUS.inProgress, STATUS.closed]);
    sim.demands.set(STATUS.closed, "assigned_to");
    expect((await b.transitions!.list!(meta(), ref(i))).map((t) => t.name)).toEqual(["In Progress", "Closed"]);
    expect(await errorOf(b.transitions!.apply!(meta(), ref(i), "status:5", {}))).toMatchObject({ kind: "invalid", message: expect.stringContaining("Assignee cannot be blank") });
    expect(await errorOf(b.transitions!.apply!(meta(), ref(i), "status:6", {}))).toMatchObject({ kind: "invalid", message: expect.stringContaining("Status is invalid") });
  });

  it("before Redmine 5.0 the allowed statuses are not given: nothing is offered rather than a guess", async () => {
    const { b, sim } = simulated();
    sim.state.v5 = false;
    expect(await b.transitions!.list!(meta(), ref(sim.issues[0]))).toEqual([]);
  });

  it("lists every status in the server's order, and the one source is the issue's status", async () => {
    const { b } = simulated();
    const probe = await b.probe(meta());
    expect(probe.activeSources.map((s) => s.kind)).toEqual(["itemState"]);
    expect(probe.rateLimit).toBeUndefined();
    const all = await b.statuses!(meta(), probe.activeSources[0]);
    expect(all.map((s) => [s.name, s.category, s.order])).toEqual([
      ["New", "todo", 0],
      ["In Progress", "doing", 1],
      ["Resolved", "doing", 2],
      ["Feedback", "doing", 3],
      ["Closed", "done", 4],
      ["Rejected", "cancelled", 5],
    ]);
  });

  it("refuses options it can't read", () => {
    expect(() => redmineProvider.parseOptions({ other: 1 })).toThrow();
    expect(redmineProvider.parseOptions(undefined)).toEqual({});
  });
});

describe("redmine, comments, watching and history", () => {
  it("a journal with no notes is only history; notes are textile; adding answers 204 and the comment is read again later", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    const r = ref(i);
    sim.outside.comment(i, "Reproduced on *iOS* 18");
    await b.transitions!.apply!(meta(), r, "status:2", {});
    expect(i.journals.some((j) => j.notes === "")).toBe(true);
    const added = await b.comments!.add!(meta(), r, markdown("Looks fine"), { idempotencyKey: "c1" });
    expect(added).toEqual({ comment: null, warnings: [] });
    const list = await b.comments!.list(meta(), r);
    expect(list.map((c) => [c.author.name, c.body])).toEqual([
      ["Anna Bianchi", { kind: "text", format: "textile", text: "Reproduced on *iOS* 18" }],
      ["Mario Rossi", { kind: "text", format: "textile", text: "Looks fine" }],
    ]);
  });

  it("markdown that textile would not show as written goes as paragraphs, and says so", async () => {
    const { b, sim } = simulated();
    const added = await b.comments!.add!(meta(), ref(sim.issues[0]), markdown("# Title\n\n**bold** and [link](http://x.y)"), { idempotencyKey: "c2" });
    expect(added.warnings.map((w) => w.feature)).toEqual(["strong", "link", "heading"]);
    expect(added.warnings.every((w) => w.code === "approximated" && !("serverDetail" in w))).toBe(true);
  });

  it("watching and unwatching twice are successes; without the permission it is forbidden", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.issues[0]);
    await b.watch!(meta(), r, true);
    await b.watch!(meta(), r, true);
    expect(sim.issues[0].watchers.has(sim.me.id)).toBe(true);
    await b.watch!(meta(), r, false);
    await b.watch!(meta(), r, false);
    expect(sim.issues[0].watchers.has(sim.me.id)).toBe(false);
    sim.state.canWatch = false;
    expect(await errorOf(b.watch!(meta(), r, true))).toMatchObject({ kind: "forbidden" });
  });

  it("history turns the journals' ids into names, in time order", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    sim.outside.status(i, STATUS.inProgress);
    sim.outside.assign(i, 78);
    sim.outside.retitle(i, "Safari login fails");
    sim.outside.moveToProject(i, "acme-platform");
    const h = await b.history!(meta(), ref(i));
    expect(h.map((c) => [c.field.name, c.from.map((v) => v.text), c.to.map((v) => v.text)])).toEqual([
      ["Status", ["New"], ["In Progress"]],
      ["Assignee", ["Mario Rossi"], ["Anna Bianchi"]],
      ["Subject", ["Login fails on Safari"], ["Safari login fails"]],
      ["Project", ["Acme web"], ["Acme platform"]],
    ]);
    expect(h[0]).toMatchObject({ actor: { name: "Anna Bianchi" }, field: { id: "status_id" }, from: [{ id: "1" }], to: [{ id: "2" }] });
    expect(h.map((c) => c.at)).toEqual([...h.map((c) => c.at)].sort((a, c) => a - c));
  });

  it("history reads custom fields, attachments and relations by what they are", async () => {
    const { b, sim } = simulated();
    const i = sim.add("acme-web", "Rich", { custom: [{ id: 3, name: "Customer", value: "B" }] });
    i.journals.push({ id: 9001, user: 78, notes: "", created: Date.now(), private: false, details: [
      { property: "cf", name: "3", old_value: "A", new_value: "B" },
      { property: "attachment", name: "55", old_value: null, new_value: "log.txt" },
      { property: "relation", name: "blocks", old_value: null, new_value: "42" },
    ] });
    const h = await b.history!(meta(), ref(i));
    expect(h.map((c) => [c.field.name, c.from.map((v) => v.text), c.to.map((v) => v.text)])).toEqual([
      ["Customer", ["A"], ["B"]],
      ["Attachment", [], ["log.txt"]],
      ["Relation (blocks)", [], ["#42"]],
    ]);
  });
});

describe("redmine, time", () => {
  it("reads the entries of one issue only: the issue filter also returns its subtasks' (and hours become seconds)", async () => {
    const { b, sim } = simulated();
    const parent = sim.issues[0];
    const child = sim.add("acme-web", "Child", { parent });
    const mine = sim.entry(parent, { hours: 1.5, spentOn: "2026-10-14", comments: "debugging" });
    sim.entry(child, { hours: 2, spentOn: "2026-10-14" });
    sim.entry(parent, { hours: 0.33, spentOn: "2026-10-15", user: 78 });
    const raw = await (await sim.fetch(`${sim.apiBase}/time_entries.json?issue_id=${parent.id}`, { headers: { "X-Redmine-API-Key": sim.token } })).json();
    expect((raw as { total_count: number }).total_count).toBe(3);
    const list = await b.worklogs!.list(meta(), ref(parent));
    expect(list.map((w) => [w.remoteId, w.span, w.comment, w.authorRemoteId, w.editable])).toEqual([
      [String(sim.entries.find((e) => e.user === 78)!.id), { kind: "date", date: "2026-10-15", seconds: 1188 }, "", "78", { update: false, delete: false }],
      [String(mine.id), { kind: "date", date: "2026-10-14", seconds: 5400 }, "debugging", String(sim.me.id), { update: true, delete: true }],
    ]);
    expect(list[1].issue).toEqual({ remoteId: String(parent.id), key: `#${parent.id}` });
    expect(list[1].activity).toEqual({ id: "9", name: "Development" });
    expect((await b.worklogs!.get!(meta(), ref(parent), String(mine.id)))?.span.seconds).toBe(5400);
    expect(await b.worklogs!.get!(meta(), ref(parent), String(sim.entries[1].id))).toBeNull();
  });

  it("the feed re-reads a window of the user's own entries by their date, issue-less ones left out", async () => {
    const { b, sim } = simulated();
    const i = sim.issues[0];
    const recent = sim.entry(i, { hours: 1, spentOn: "2026-10-20" });
    const edge = sim.entry(i, { hours: 1, spentOn: "2026-09-21" });
    const old = sim.entry(i, { hours: 1, spentOn: "2026-08-01" });
    const tomorrow = sim.entry(i, { hours: 1, spentOn: "2026-10-22" });
    sim.entry(i, { hours: 1, spentOn: "2026-10-20", user: 78 });
    const onProject = sim.entry(null, { hours: 1, spentOn: "2026-10-20", project: "acme-web" });
    const f = await feed(b);
    const ids = f.items.map((w) => w.remoteId);
    expect(ids).toEqual(expect.arrayContaining([String(recent.id), String(edge.id), String(tomorrow.id)]));
    expect(ids).not.toContain(String(old.id));
    expect(ids).not.toContain(String(onProject.id));
    expect(f.items.every((w) => w.authorRemoteId === String(sim.me.id) && w.issue)).toBe(true);
    expect(f.gone).toEqual([]);
    expect(f.checkpoint).not.toBeNull();
  });

  it("pages the feed by offset (newest day first by default), and a pass is the same twice", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 130; n++) sim.entry(sim.issues[0], { hours: 0.25, spentOn: `2026-10-${String(1 + (n % 20)).padStart(2, "0")}` });
    const f = await feed(b);
    expect(f.pages).toBe(2);
    expect(new Set(f.items.map((w) => w.remoteId)).size).toBe(130);
    expect((await feed(b, f.checkpoint)).items.length).toBe(130);
  });

  it("creates with the server's default activity when none is given, and reads back what Redmine stored", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.issues[0]);
    const made = await b.worklogs!.create!(meta(), r, input(5400), { idempotencyKey: "k1" });
    expect(made).toMatchObject({ span: { kind: "date", date: "2026-10-14", seconds: 5400 }, activity: { id: "9", name: "Development" }, comment: "work", editable: { update: true, delete: true } });
    const design = await b.worklogs!.create!(meta(), r, { ...input(1800), activityId: "8" }, { idempotencyKey: "k2" });
    expect(design.activity).toEqual({ id: "8", name: "Design" });
  });

  it("hours are kept to two places: 36-second steps, and shorter than that is refused before the call", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.issues[0]);
    expect((await b.worklogs!.create!(meta(), r, input(100), { idempotencyKey: "k" })).span.seconds).toBe(108);
    const calls = sim.state.calls;
    expect(await errorOf(b.worklogs!.create!(meta(), r, input(10), { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid" });
    expect(sim.state.calls).toBe(calls);
    expect(await errorOf(b.worklogs!.create!(meta(), r, { time: { kind: "session", start: 0 as never, seconds: 60 }, comment: "" }, { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid" });
  });

  it("an activity is required: a server with no default refuses with its words, and a project may not offer the one given", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.issues[0]);
    sim.noDefaultActivity();
    expect(await errorOf(b.worklogs!.create!(meta(), r, input(3600), { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid", message: expect.stringContaining("Activity cannot be blank") });
    expect((await b.worklogs!.create!(meta(), r, { ...input(3600), activityId: "10" }, { idempotencyKey: "k" })).activity?.name).toBe("Testing");
    sim.project("acme-web", { activities: [8] });
    expect(await errorOf(b.worklogs!.create!(meta(), r, { ...input(3600), activityId: "10" }, { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid", message: expect.stringContaining("Activity is invalid") });
    expect(await errorOf(b.worklogs!.create!(meta(), r, { ...input(3600), activityId: "11" }, { idempotencyKey: "k" }))).toMatchObject({ kind: "invalid" });
  });

  it("lists the activities: a project's own when it offers fewer, else the whole catalogue (inactive ones left out)", async () => {
    const { b, sim } = simulated();
    const all = await b.worklogs!.activities!(meta(), {}, 10);
    expect(all).toEqual({ items: [{ id: "8", name: "Design" }, { id: "9", name: "Development" }, { id: "10", name: "Testing" }], complete: true });
    sim.project("acme-web", { activities: [9] });
    expect((await b.worklogs!.activities!(meta(), { issue: ref(sim.issues[0]) }, 10)).items).toEqual([{ id: "9", name: "Development" }]);
    const cut = await b.worklogs!.activities!(meta(), {}, 2);
    expect(cut.items.length).toBe(2);
    expect(cut.complete).toBe(false);
  });

  it("a comment longer than 1024 characters is refused by Redmine, in its words", async () => {
    const { b, sim } = simulated();
    const err = await errorOf(b.worklogs!.create!(meta(), ref(sim.issues[0]), { ...input(3600), comment: "x".repeat(1025) }, { idempotencyKey: "k" }));
    expect(err).toMatchObject({ kind: "invalid", message: expect.stringContaining("maximum is 1024") });
  });

  it("logging for someone else without the permission is ignored by Redmine (the entry is the caller's): the adapter takes it back and says forbidden", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.issues[0]);
    const err = await errorOf(b.worklogs!.create!(meta(), r, { ...input(3600), onBehalfOfRemoteId: "78" }, { idempotencyKey: "k" }));
    expect(err).toMatchObject({ kind: "forbidden" });
    expect(sim.entries).toEqual([]);
    sim.state.canLogForOthers = true;
    const made = await b.worklogs!.create!(meta(), r, { ...input(3600), onBehalfOfRemoteId: "78" }, { idempotencyKey: "k" });
    expect(made).toMatchObject({ authorRemoteId: "78", editable: { update: false, delete: false } });
  });

  it("an update answers 204 and the entry is read again; deleting what is gone is a success", async () => {
    const { b, sim } = simulated();
    const r = ref(sim.issues[0]);
    const made = await b.worklogs!.create!(meta(), r, input(3600), { idempotencyKey: "k" });
    const real = sim.fetch;
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: string | URL | Request, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${new URL(String(u)).pathname}`);
      return real(u, init);
    });
    const changed = await b.worklogs!.update!(meta(), r, made.remoteId, { time: { kind: "date", date: "2026-10-15" as never, seconds: 1800 }, comment: "moved" }, {});
    expect(changed).toMatchObject({ span: { date: "2026-10-15", seconds: 1800 }, comment: "moved" });
    expect(seen).toEqual([`PUT /time_entries/${made.remoteId}.json`, `GET /time_entries/${made.remoteId}.json`]);
    await b.worklogs!.delete!(meta(), r, made.remoteId, {});
    await b.worklogs!.delete!(meta(), r, made.remoteId, {});
    expect(await errorOf(b.worklogs!.update!(meta(), r, made.remoteId, input(60), {}))).toMatchObject({ kind: "notFound" });
  });

  it("someone else's entry cannot be changed: forbidden", async () => {
    const { b, sim } = simulated();
    const theirs = sim.entry(sim.issues[0], { hours: 1, spentOn: "2026-10-14", user: 78 });
    expect(await errorOf(b.worklogs!.update!(meta(), ref(sim.issues[0]), String(theirs.id), input(3600), {}))).toMatchObject({ kind: "forbidden" });
    expect(await errorOf(b.worklogs!.delete!(meta(), ref(sim.issues[0]), String(theirs.id), {}))).toMatchObject({ kind: "forbidden" });
  });

  it("spent time is left out of the issue when the account may not see time entries", async () => {
    const { b, sim } = simulated();
    sim.entry(sim.issues[0], { hours: 2, spentOn: "2026-10-14" });
    expect((await b.getIssue(meta(), ref(sim.issues[0])))?.spentSeconds).toBe(7200);
    sim.state.hideSpent = true;
    expect((await b.getIssue(meta(), ref(sim.issues[0])))?.spentSeconds).toBeNull();
  });
});

describe("redmine, webhooks", () => {
  const req = (headers: Record<string, string>, body = "{}") => ({ headers, body });

  it("accepts the delivery whose X-Inkledger-Secret is the secret, and refuses any other", () => {
    expect(verifyRedmineWebhook(req({ "x-inkledger-secret": "s3cret" }), "s3cret")).toBe(true);
    expect(verifyRedmineWebhook(req({ "x-inkledger-secret": "s3cret2" }), "s3cret")).toBe(false);
    expect(verifyRedmineWebhook(req({ "x-inkledger-secret": "" }), "s3cret")).toBe(false);
    expect(verifyRedmineWebhook(req({}), "s3cret")).toBe(false);
    // A hook with no secret set is open to anyone: never accepted.
    expect(verifyRedmineWebhook(req({}), "")).toBe(false);
    expect(verifyRedmineWebhook(req({ "x-inkledger-secret": "" }), "")).toBe(false);
    expect(redmineProvider.webhook!.verify(req({ "x-inkledger-secret": "k" }), "k")).toBe(true);
  });

  it("names the delivery (its header, else a hash of the body) and when it was sent", () => {
    expect(redmineDeliveryId(req({ "x-inkledger-delivery": "d-1" }))).toBe("d-1");
    const a = redmineDeliveryId(req({}, '{"issue":1}'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(redmineDeliveryId(req({}, '{"issue":1}'))).toBe(a);
    expect(redmineDeliveryId(req({}, '{"issue":2}'))).not.toBe(a);
    expect(redmineDeliveryId(req({}, ""))).toBeNull();
    expect(redmineSentAt(req({}, '{"timestamp":1790000000000}'))).toBe(1_790_000_000_000);
    expect(redmineSentAt(req({}, '{"timestamp":1790000000}'))).toBe(1_790_000_000_000);
    expect(redmineSentAt(req({}, "not json"))).toBeNull();
    expect(redmineSentAt(req({}, "{}"))).toBeNull();
  });
});

describe("redmine, errors and limits", () => {
  it("a bad key is auth (401, an empty body)", async () => {
    const { b } = simulated({ token: "wrong" });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "auth" });
  });

  it("a revoked key is auth on every call", async () => {
    const { b, sim } = simulated();
    expect((await b.verify(meta())).remoteId).toBe(String(sim.me.id));
    sim.revoke();
    expect(await errorOf(pass(b))).toMatchObject({ kind: "auth" });
  });

  it("an exhausted proxy is a wait: 429 with Retry-After and an HTML body", async () => {
    const { b, sim } = simulated();
    sim.exhaust();
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 30_000 } });
    sim.refill();
    expect((await b.verify(meta())).name).toBe("Mario Rossi");
  });

  it("reads Retry-After as a date, and the reset header, when a proxy sends those instead", async () => {
    const { b } = simulated();
    const answer = (headers: Record<string, string>) => vi.stubGlobal("fetch", async () => new Response("slow down", { status: 429, headers }));
    answer({ "Retry-After": new Date(NOW + 12_000).toUTCString() });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 12_000 } });
    answer({ "X-RateLimit-Reset": String(Math.floor(NOW / 1000) + 5), "X-RateLimit-Remaining": "0" });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 5_000, remaining: 0 } });
    answer({});
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 30_000 } });
  });

  it("a missing issue is notFound where an operation needs it, null where a lookup asks", async () => {
    const { b } = simulated();
    const ghost = { remoteId: "99999", key: "#99999" };
    expect(await b.getIssue(meta(), ghost)).toBeNull();
    expect(await errorOf(b.transitions!.list!(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.comments!.list(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.watch!(meta(), ghost, true))).toMatchObject({ kind: "notFound" });
  });

  it("validation errors are messages, not fields: Redmine's words arrive as the message", async () => {
    const { b, sim } = simulated();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ errors: ["Subject cannot be blank", "Hours is invalid"] }), { status: 422 }));
    expect(await errorOf(b.transitions!.apply!(meta(), ref(sim.issues[0]), "status:2", {}))).toMatchObject({ kind: "invalid", message: "Redmine: Subject cannot be blank; Hours is invalid" });
  });

  it("a server with the REST API off answers HTML: incompatible, with a hint, never parsed as data", async () => {
    const { b, sim } = simulated();
    sim.state.html = true;
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "incompatible", message: expect.stringContaining("not JSON") });
  });

  it("knows who the key belongs to", async () => {
    const { b, sim } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: String(sim.me.id), name: "Mario Rossi", handle: "mrossi", login: "mrossi", email: "mario@example.com" });
  });

  it("works under a sub-URI", async () => {
    const { b, conn } = simulated({ apiBase: "https://example.org/redmine" });
    expect((await bindTracker(redmineProvider, conn).verify(meta())).name).toBe("Mario Rossi");
    expect(b.parseRef("https://example.org/redmine/issues/4")).toEqual({ key: "#4" });
  });
});
