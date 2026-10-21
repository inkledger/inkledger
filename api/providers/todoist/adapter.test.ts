import { describe, expect, it, vi } from "vitest";
import { markdown, timeZone } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { encodeCheckpoint } from "../core/checkpoint";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import type { Checkpoint } from "../types";
import { PAGE_LIMIT } from "./client";
import { BUDGET, todoistSimulator } from "./simulator";
import { dueDay, escapeFilter, todoistProvider, todoistWebhook, type TodoistOptions } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "104.192.140.1", family: 4 }]),
}));

const CATEGORIES: TodoistOptions["categories"] = { backlog: "backlog", doing: "doing", "in corso": "doing", done: "done", fatto: "done", "won't do": "cancelled" };

// Ids as the unified API makes them: opaque, ending here in digits.
const LOGIN = "6LoginSafari01";
const EXPORT = "6ExportCsv0002";
const CERTS = "6RotateCerts003";
const WATER = "6WaterPlants004";
const ANNA = "6AnnaOwnTask005";
const SUB = "6WriteTest00006";

function simulated(o: { options?: unknown; token?: string } = {}) {
  const sim = todoistSimulator();
  const anna = sim.addUser("Anna Bianchi");
  sim.addProject("Acme Web", { members: [anna], sections: ["Backlog", "Doing", "Done", "Won't do"] });
  sim.addProject("Personal", { inbox: true });
  sim.addProject("Operations", { sections: ["Da fare", "In corso", "Fatto"] });
  sim.addProject("Old project", { archived: true });
  const login = sim.add("Acme Web", "Login fails on Safari", {
    id: LOGIN,
    section: "Doing",
    assignee: sim.me,
    priority: 4,
    labels: ["bug", "safari"],
    description: "Steps:\n\n1. open\n2. **fail**",
    // A fixed instant: 23:30 UTC, with the zone the task was made in beside it.
    due: { date: "2026-10-30T23:30:00Z", timezone: "America/New_York" },
    deadline: "2026-11-05",
  });
  sim.add("Acme Web", "Write the regression test", { id: SUB, parent: login, assignee: sim.me });
  sim.add("Acme Web", "Export to CSV", { id: EXPORT, assignee: sim.me, due: "2026-10-30", priority: 2 });
  // Floating: the user's own clock, no zone.
  sim.add("Personal", "Rotate certificates", { id: CERTS, due: "2026-10-30T23:30:00" });
  sim.add("Personal", "Water the plants", { id: WATER, due: { date: "2026-10-21", is_recurring: true, string: "every day" } });
  sim.add("Acme Web", "Anna's own", { id: ANNA, assignee: anna });
  sim.add("Acme Web", "Nobody's yet");
  sim.live();
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 9,
    userId: 1,
    type: "todoist" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: sim.me.id,
    options: o.options ?? { categories: CATEGORIES },
    timeZone: timeZone("Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, anna, conn, b: bindTracker(todoistProvider, conn) };
}

trackerConformance("todoist (simulated)", async () => {
  const { conn } = simulated();
  return { provider: todoistProvider, conn, key: LOGIN, writable: true, url: `https://app.todoist.com/app/task/login-fails-on-safari-${LOGIN}` };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const pass = (b: ReturnType<typeof simulated>["b"], since: Checkpoint | null = null) => readPass((q) => b.listChanged(meta(), q), since);
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; status?: number; message: string; rateLimit?: { retryAfterMs?: number; remaining?: number } });
const refOf = (id: string) => ({ remoteId: id, key: id });
const keys = (items: { key: string }[]) => items.map((i) => i.key).sort();

describe("todoist, tasks", () => {
  it("lists the tasks assigned to the user and the unassigned ones of their own projects, with the section as status and the project as container", async () => {
    const { b, sim } = simulated();
    const all = await pass(b);
    // Not Anna's, not the unassigned one in a shared project.
    expect(keys(all.items)).toEqual([CERTS, EXPORT, LOGIN, SUB, WATER].sort());
    const by = (k: string) => all.items.find((i) => i.key === k)!;
    expect([by(LOGIN).status.name, by(LOGIN).status.category]).toEqual(["Doing", "doing"]);
    expect([by(EXPORT).status.name, by(EXPORT).status.category]).toEqual(["Open", "todo"]);
    expect(by(LOGIN)).toMatchObject({
      remoteId: LOGIN,
      url: `https://app.todoist.com/app/task/${LOGIN}`,
      type: { id: "task", level: "standard" },
      container: { remoteId: sim.project("Acme Web").id, name: "Acme Web", kind: "project" },
      status: { source: { kind: "column", boardRemoteId: sim.project("Acme Web").id }, categoryOrigin: { by: "mapping" } },
    });
    expect(by(EXPORT).status.source).toEqual({ kind: "boolean" });
    expect(by(CERTS).container).toMatchObject({ name: "Personal" });
    expect(all.gone).toEqual([]);
    expect(all.checkpoint).not.toBeNull();
  });

  it("reads labels (names), people, dates, the sub-task's parent and the fields it does not map", async () => {
    const { b, sim } = simulated();
    const i = (await b.getIssue(meta(), refOf(LOGIN)))!;
    expect(i.labels).toEqual(["bug", "safari"]);
    expect(i.assignees.map((a) => [a.remoteId, a.name])).toEqual([[sim.me.id, "Mario Rossi"]]);
    expect(i.reporter).toMatchObject({ remoteId: sim.me.id });
    expect(i.createdAt).toBe(Date.parse(sim.task(LOGIN).added_at!));
    expect(i.fields).toMatchObject({ deadline: "2026-11-05", dueAt: "2026-10-30T23:30:00Z", dueTimezone: "America/New_York" });
    expect(i.estimateSeconds).toBeNull();
    const sub = (await b.getIssue(meta(), refOf(SUB)))!;
    expect(sub).toMatchObject({ type: { level: "sub" }, parent: { remoteId: LOGIN, key: LOGIN } });
    // Someone else's name comes from the project's collaborators.
    sim.outside.assign(EXPORT, sim.users.get(sim.task(ANNA).responsible_uid!)!);
    expect((await b.getIssue(meta(), refOf(EXPORT)))?.assignees.map((a) => a.name)).toEqual(["Anna Bianchi"]);
  });

  it("priority 4 is 'p1' in the app: urgent, rank 0; the default 1 is none", async () => {
    const { b } = simulated();
    expect((await b.getIssue(meta(), refOf(LOGIN)))?.priority).toEqual({ id: "4", name: "P1 (urgent)", rank: 0 });
    expect((await b.getIssue(meta(), refOf(EXPORT)))?.priority).toEqual({ id: "2", name: "P3 (medium)", rank: 3 });
    expect((await b.getIssue(meta(), refOf(CERTS)))?.priority).toBeNull();
  });

  it("a due date is a day, a floating time or a fixed instant: only the instant is moved to the user's zone", async () => {
    const { b } = simulated();
    // 23:30 UTC on the 30th is already the 31st in Rome (CET after 25 October), whatever zone the task was made in.
    expect((await b.getIssue(meta(), refOf(LOGIN)))?.due).toBe("2026-10-31");
    expect((await b.getIssue(meta(), refOf(EXPORT)))?.due).toBe("2026-10-30");
    // 23:30 on the user's own clock stays the 30th.
    expect((await b.getIssue(meta(), refOf(CERTS)))?.due).toBe("2026-10-30");
    const zone = timeZone("Europe/Rome");
    expect(dueDay(zone, { date: "2026-10-30T23:30:00+02:00", is_recurring: false })).toBe("2026-10-30");
    expect(dueDay(zone, { date: "2026-06-30T23:30:00Z", is_recurring: false })).toBe("2026-07-01");
    expect(dueDay(zone, { date: "garbage", is_recurring: false })).toBeNull();
    expect(dueDay(zone, null)).toBeNull();
  });

  it("an id survives a move to another project and section; found by either name, and the old numeric id of an old link goes through the mapping", async () => {
    const { b, sim } = simulated();
    const before = (await b.getIssue(meta(), refOf(LOGIN)))!;
    sim.outside.move(LOGIN, "Operations", "In corso");
    const after = (await b.getIssue(meta(), refOf(LOGIN)))!;
    expect([after.remoteId, after.key]).toEqual([before.remoteId, LOGIN]);
    expect(after.container.name).toBe("Operations");
    expect(after.status).toMatchObject({ name: "In corso", category: "doing" });
    for (const handle of [{ key: LOGIN }, { remoteId: LOGIN }]) {
      const f = await b.findIssue(meta(), handle);
      expect(f.kind === "found" && f.issue.remoteId).toBe(LOGIN);
    }
    // The unified API refuses the number; the mapping gives the id.
    const legacy = sim.task(EXPORT).legacyId;
    expect((await sim.fetch(`${sim.apiBase}/api/v1/tasks/${legacy}`, { headers: { authorization: `Bearer ${sim.token}` } })).status).toBe(400);
    sim.calls.length = 0;
    const found = await b.findIssue(meta(), { key: legacy });
    expect(found.kind === "found" && found.issue.key).toBe(EXPORT);
    expect(sim.calls.some((c) => c.path.includes("/id_mappings/tasks/"))).toBe(true);
    expect((await b.findIssue(meta(), { key: "9999999999" })).kind).toBe("none");
  });

  it("parses keys and links of the service, and nothing else", () => {
    const { b } = simulated();
    expect(b.normalizeKey(LOGIN)).toBe(LOGIN);
    expect(b.normalizeKey("  2995104339 ")).toBe("2995104339");
    // A word is not a key: an id has a digit in it.
    expect(b.normalizeKey("important")).toBeNull();
    expect(b.normalizeKey("ab1")).toBeNull();
    expect(b.normalizeKey("6Login-Safari")).toBeNull();
    expect(b.parseRef(`https://app.todoist.com/app/task/login-fails-on-safari-${LOGIN}`)).toEqual({ key: LOGIN });
    expect(b.parseRef(`https://app.todoist.com/app/task/${LOGIN}`)).toEqual({ key: LOGIN });
    expect(b.parseRef(`https://todoist.com/app/project/inbox-2203306141/task/buy-milk-${LOGIN}/`)).toEqual({ key: LOGIN });
    expect(b.parseRef("https://todoist.com/showTask?id=2995104339")).toEqual({ key: "2995104339" });
    expect(b.parseRef("https://app.todoist.com/app/project/inbox-2203306141")).toBeNull();
    expect(b.parseRef(`http://app.todoist.com/app/task/${LOGIN}`)).toBeNull();
    expect(b.parseRef(`https://todoist.example.com/app/task/${LOGIN}`)).toBeNull();
  });

  it("has no query language and keeps time in inkledger", () => {
    expect(todoistProvider.capabilities.time).toEqual({ mode: "local", remoteTotals: false });
    expect(todoistProvider.worklogs).toBeUndefined();
    expect("query" in todoistProvider).toBe(false);
    expect("translate" in todoistProvider).toBe(false);
  });
});

describe("todoist, passes", () => {
  it("is the Sync API: a token for a checkpoint, and from it only what changed", async () => {
    const { b, sim } = simulated();
    const first = await pass(b);
    expect(sim.calls.filter((c) => c.path === "/api/v1/sync")).toHaveLength(1);
    expect(JSON.parse(sim.calls.find((c) => c.path === "/api/v1/sync")!.body)).toEqual({ sync_token: "*", resource_types: ["items"] });
    expect((await pass(b, first.checkpoint)).items).toEqual([]);
    sim.outside.rename(EXPORT, "Export to CSV and XLSX");
    sim.outside.assign(ANNA, null);
    const next = await pass(b, first.checkpoint);
    // Anna's task is nobody's now, in a shared project: not the user's.
    expect(next.items.map((i) => [i.key, i.title])).toEqual([[EXPORT, "Export to CSV and XLSX"]]);
    expect(next.checkpoint).not.toBe(first.checkpoint);
    expect(JSON.parse(sim.calls.filter((c) => c.path === "/api/v1/sync").at(-1)!.body)).toMatchObject({ sync_token: expect.stringMatching(/^st:\d+$/) });
  });

  it("a first read has no completed tasks; a later one has them, checked, as done", async () => {
    const { b, sim } = simulated();
    sim.outside.complete(EXPORT);
    sim.outside.complete(WATER);
    const first = await pass(b);
    // Completed before the first read: not in a full sync. The recurring one stays open.
    expect(keys(first.items)).not.toContain(EXPORT);
    expect(keys(first.items)).toContain(WATER);
    sim.outside.complete(CERTS);
    const next = await pass(b, first.checkpoint);
    expect(next.items.map((i) => [i.key, i.status.name, i.status.category])).toEqual([[CERTS, "Completed", "done"]]);
    expect(next.items[0].statusChangedAt).toBe(Date.parse(sim.task(CERTS).completed_at!));
    expect(next.gone).toEqual([]);
  });

  it("completing a task completes its sub-tasks: both come back done", async () => {
    const { b, sim } = simulated();
    const first = await pass(b);
    sim.outside.complete(LOGIN);
    const next = await pass(b, first.checkpoint);
    expect(next.items.map((i) => [i.key, i.status.category]).sort()).toEqual([[LOGIN, "done"], [SUB, "done"]].sort());
  });

  it("a deleted task (and its sub-tasks) is reported deleted; a task reassigned to someone else is not told apart and simply stops coming", async () => {
    const { b, sim, anna } = simulated();
    const first = await pass(b);
    sim.outside.delete(LOGIN);
    sim.outside.assign(EXPORT, anna);
    const next = await pass(b, first.checkpoint);
    expect(next.gone.map((g) => g.remoteId).sort()).toEqual([LOGIN, SUB].sort());
    expect(next.gone.every((g) => g.reason === "deleted")).toBe(true);
    expect(next.items).toEqual([]);
    // Soft-deleted: gone from both reads.
    expect(await b.getIssue(meta(), refOf(LOGIN))).toBeNull();
    expect((await b.findIssue(meta(), { key: LOGIN })).kind).toBe("none");
  });

  it("a sync token it does not know is a full sync, without a word: everything again, nothing reported gone", async () => {
    const { b, sim, conn } = simulated();
    const stale = encodeCheckpoint(conn, "issues", 1, { token: "forgotten-token" });
    sim.outside.delete(EXPORT);
    const again = await pass(b, stale);
    expect(keys(again.items)).toEqual([CERTS, LOGIN, SUB, WATER].sort());
    expect(again.gone).toEqual([]);
  });

  it("reads a long list by cursor, 200 at a time (more is a 400)", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 230; n++) sim.add("Personal", `Chore ${n}`);
    const res = await sim.fetch(`${sim.apiBase}/api/v1/tasks?limit=${PAGE_LIMIT + 1}`, { headers: { authorization: `Bearer ${sim.token}` } });
    expect(res.status).toBe(400);
    sim.calls.length = 0;
    const sections = await b.statuses!(meta(), (await b.probe(meta())).activeSources.find((s) => s.kind === "boolean")!);
    expect(sections).toHaveLength(2);
    const w = await b.searchText!(meta(), "chore", 1000);
    expect(w.items).toHaveLength(230);
    expect(w.complete).toBe(true);
    const pages = sim.calls.filter((c) => c.path === "/api/v1/tasks/filter");
    expect(pages).toHaveLength(2);
    expect(pages.every((c) => c.search.includes(`limit=${PAGE_LIMIT}`))).toBe(true);
    expect(pages[1].search).toContain("cursor=c200");
  });

  it("refuses a checkpoint or page token it didn't write, and a different format", async () => {
    const { b } = simulated();
    await expect(b.listChanged(meta(), { since: "cp1.eyJ9" as Checkpoint, page: null })).rejects.toMatchObject({ kind: "invalidCheckpoint" });
    await expect(b.listChanged(meta(), { since: null, page: "pg1.eyJ9" as never })).rejects.toMatchObject({ kind: "invalidCheckpoint" });
  });
});

describe("todoist, workflow", () => {
  it("categories come from the connection's mapping, by section id before name (any case), and an unmapped section is todo", async () => {
    const { b, sim, conn } = simulated({ options: { categories: { DOING: "doing" } } });
    expect((await b.getIssue(meta(), refOf(LOGIN)))?.status).toMatchObject({ name: "Doing", category: "doing" });
    sim.outside.setSection(LOGIN, "Backlog");
    expect((await b.getIssue(meta(), refOf(LOGIN)))?.status).toMatchObject({ name: "Backlog", category: "todo" });
    // The id wins over the name.
    const doing = sim.sections.find((s) => s.name === "Doing")!;
    const byId = bindTracker(todoistProvider, { ...conn, options: { categories: { [doing.id]: "cancelled", doing: "doing" } } });
    sim.outside.setSection(LOGIN, "Doing");
    expect((await byId.getIssue(meta(), refOf(LOGIN)))?.status.category).toBe("cancelled");
    expect(() => todoistProvider.parseOptions({ categories: { x: "nonsense" } })).toThrow();
    expect(todoistProvider.parseOptions(undefined)).toEqual({ categories: {} });
  });

  it("probes the open/completed source and one column source per project with sections (archived projects and bare ones left out), and reads each project's sections in order", async () => {
    const { b, sim } = simulated();
    const probe = await b.probe(meta());
    expect(probe.activeSources.map((s) => [s.name, s.kind])).toEqual([
      ["Open / completed", "boolean"],
      ["Acme Web", "column"],
      ["Operations", "column"],
    ]);
    expect(probe.rateLimit).toEqual({ perHour: 1800, origin: "typical" });
    const [bool, acme, ops] = probe.activeSources;
    expect(acme.ref).toEqual({ kind: "column", boardRemoteId: sim.project("Acme Web").id });
    expect((await b.statuses!(meta(), bool)).map((s) => [s.name, s.category])).toEqual([
      ["Open", "todo"],
      ["Completed", "done"],
    ]);
    expect((await b.statuses!(meta(), acme)).map((s) => [s.name, s.category])).toEqual([
      ["Backlog", "backlog"],
      ["Doing", "doing"],
      ["Done", "done"],
      ["Won't do", "cancelled"],
    ]);
    expect((await b.statuses!(meta(), ops)).map((s) => [s.name, s.category])).toEqual([
      ["Da fare", "todo"],
      ["In corso", "doing"],
      ["Fatto", "done"],
    ]);
  });

  it("offers to complete, to move to any other section of the task's project, and out of its section; moves along one", async () => {
    const { b, sim } = simulated();
    const ref = refOf(LOGIN);
    const ways = await b.transitions!.list!(meta(), ref);
    expect(ways.map((t) => [t.name, t.to.category])).toEqual([
      ["Complete", "done"],
      ["Backlog", "backlog"],
      ["Done", "done"],
      ["Won't do", "cancelled"],
      ["No section", "todo"],
    ]);
    expect(ways.every((t) => t.requirements.length === 0 && t.remoteUrl === `https://app.todoist.com/app/task/${LOGIN}`)).toBe(true);
    const done = ways.find((t) => t.name === "Done")!;
    const moved = await b.transitions!.apply!(meta(), ref, done.id, {});
    expect(moved?.status).toMatchObject({ name: "Done", category: "done" });
    expect(sim.task(LOGIN).section_id).toBe(done.id.slice("section:".length));
    expect(sim.task(LOGIN).checked).toBe(false);
    // Out of every section: the project's root, not another project.
    const out = await b.transitions!.apply!(meta(), ref, "section:none", {});
    expect(out?.status).toMatchObject({ name: "Open", category: "todo" });
    expect(out?.container.name).toBe("Acme Web");
    expect(await errorOf(b.transitions!.apply!(meta(), ref, "nonsense", {}))).toMatchObject({ kind: "invalid" });
    expect(await errorOf(b.transitions!.apply!(meta(), ref, "section:6NoSuchSection01", {}))).toMatchObject({ kind: "notFound" });
  });

  it("completes: a completed task is not read by /tasks/{id} (404) but by the Sync API's item read; reopening brings it back", async () => {
    const { b, sim } = simulated();
    const ref = refOf(EXPORT);
    sim.calls.length = 0;
    const done = await b.transitions!.apply!(meta(), ref, "complete", {});
    expect(done?.status).toMatchObject({ name: "Completed", category: "done" });
    expect(sim.calls.some((c) => c.method === "POST" && c.path === `/api/v1/tasks/${EXPORT}/close`)).toBe(true);
    expect(sim.calls.some((c) => c.path === "/api/v1/sync/items/get")).toBe(true);
    expect((await sim.fetch(`${sim.apiBase}/api/v1/tasks/${EXPORT}`, { headers: { authorization: `Bearer ${sim.token}` } })).status).toBe(404);
    // A completed task has one way out.
    expect((await b.transitions!.list!(meta(), ref)).map((t) => [t.id, t.to.name])).toEqual([["reopen", "Open"]]);
    // Completing it twice is not an error.
    expect((await b.transitions!.apply!(meta(), ref, "complete", {}))?.status.name).toBe("Completed");
    const back = await b.transitions!.apply!(meta(), ref, "reopen", {});
    expect(back?.status).toMatchObject({ name: "Open", category: "todo" });
  });

  it("completing a recurring task moves its due date on and leaves it open", async () => {
    const { b, sim } = simulated();
    const done = await b.transitions!.apply!(meta(), refOf(WATER), "complete", {});
    expect(done?.status).toMatchObject({ name: "Open", category: "todo" });
    expect(done?.due).toBe("2026-10-22");
    expect(done?.fields).toMatchObject({ recurring: "every day" });
    expect(sim.task(WATER).checked).toBe(false);
  });
});

describe("todoist, texts", () => {
  it("reads the description as Markdown, and none as null", async () => {
    const { b } = simulated();
    expect(await b.description!(meta(), refOf(LOGIN))).toEqual({ kind: "text", format: "commonmark", text: "Steps:\n\n1. open\n2. **fail**" });
    expect(await b.description!(meta(), refOf(EXPORT))).toBeNull();
  });

  it("reads comments oldest first, all of them (50 by default, 200 at most, by cursor), with their authors' names, and writes comments", async () => {
    const { b, sim, anna } = simulated();
    const ref = { ...refOf(LOGIN), container: { remoteId: sim.project("Acme Web").id, key: sim.project("Acme Web").id } };
    for (let n = 1; n <= 230; n++) sim.outside.comment(LOGIN, `Comment ${n}`, n % 2 ? sim.me : anna);
    sim.calls.length = 0;
    const list = await b.comments!.list(meta(), ref);
    expect(list).toHaveLength(230);
    expect(list[0].body).toEqual({ kind: "text", format: "commonmark", text: "Comment 1" });
    expect(list[0].author).toMatchObject({ remoteId: sim.me.id, name: "Mario Rossi" });
    expect(list[1].author).toMatchObject({ remoteId: anna.id, name: "Anna Bianchi" });
    expect(new Set(list.map((c) => c.id)).size).toBe(230);
    const pages = sim.calls.filter((c) => c.path === "/api/v1/comments");
    expect(pages).toHaveLength(2);
    expect(pages[1].search).toContain("cursor=c200");

    const added = await b.comments!.add!(meta(), ref, markdown("Looks **fixed**"), { idempotencyKey: "c1" });
    expect(added.warnings).toEqual([]);
    expect(added.comment).toMatchObject({ author: { remoteId: sim.me.id }, body: { text: "Looks **fixed**" } });
    expect((await b.comments!.list(meta(), ref)).at(-1)?.body).toMatchObject({ text: "Looks **fixed**" });
    expect(await errorOf(b.comments!.add!(meta(), ref, markdown(""), { idempotencyKey: "c2" }))).toMatchObject({ kind: "invalid" });
  });

  it("a comment in a project of one's own is by the user, found without the project hint", async () => {
    const { b, sim } = simulated();
    sim.outside.comment(CERTS, "renewed");
    const [c] = await b.comments!.list(meta(), refOf(CERTS));
    expect(c.author).toMatchObject({ remoteId: sim.me.id, name: "Mario Rossi" });
  });

  it("tells a task's history field by field, oldest first (activities page by 100)", async () => {
    const { b, sim, anna } = simulated();
    sim.outside.rename(EXPORT, "Export to CSV and XLSX", anna);
    sim.outside.setDue(EXPORT, "2026-11-02", anna);
    sim.outside.assign(EXPORT, anna);
    sim.outside.complete(EXPORT);
    sim.outside.reopen(EXPORT);
    sim.calls.length = 0;
    const history = await b.history!(meta(), refOf(EXPORT));
    expect(sim.calls.find((c) => c.path === "/api/v1/activities")!.search).toContain("limit=100");
    expect(history.map((h) => [h.field.name, h.from.map((v) => v.text), h.to.map((v) => v.text)])).toEqual([
      ["Title", ["Export to CSV"], ["Export to CSV and XLSX"]],
      ["Due date", ["2026-10-30"], ["2026-11-02"]],
      ["Assignee", ["Mario Rossi"], ["Anna Bianchi"]],
      ["Status", ["Open"], ["Completed"]],
      ["Status", ["Completed"], ["Open"]],
    ]);
    expect(history[0].actor).toMatchObject({ remoteId: anna.id, name: "Anna Bianchi" });
    expect(history.map((h) => h.at)).toEqual([...history.map((h) => h.at)].sort((x, y) => x - y));
    const res = await sim.fetch(`${sim.apiBase}/api/v1/activities?object_type=item&object_id=${EXPORT}&limit=101`, { headers: { authorization: `Bearer ${sim.token}` } });
    expect(res.status).toBe(400);
  });

  it("searches by text with the filter syntax: its operators are escaped, finished tasks and unreadable projects are left out", async () => {
    const { b, sim } = simulated();
    sim.add("Personal", "R&D plan, (draft)!", { assignee: sim.me });
    sim.add("Personal", "Finished chore");
    sim.outside.complete("Finished chore");
    expect(escapeFilter("a&b|c!d(e)f,g\\h")).toBe("a\\&b\\|c\\!d\\(e\\)f\\,g\\\\h");
    sim.calls.length = 0;
    const r = await b.searchText!(meta(), "R&D plan, (draft)!", 10);
    expect(r.items.map((i) => i.title)).toEqual(["R&D plan, (draft)!"]);
    expect(r.complete).toBe(true);
    expect(new URLSearchParams(sim.calls.find((c) => c.path === "/api/v1/tasks/filter")!.search).get("query")).toBe("search: R\\&D plan\\, \\(draft\\)\\!");
    // Unescaped, the same filter is refused: the simulator keeps the trap.
    const bare = await sim.fetch(`${sim.apiBase}/api/v1/tasks/filter?query=${encodeURIComponent("search: R&D")}`, { headers: { authorization: `Bearer ${sim.token}` } });
    expect(bare.status).toBe(400);
    // Anyone's tasks, any section of the readable projects.
    expect((await b.searchText!(meta(), "own", 10)).items.map((i) => i.key)).toEqual([ANNA]);
    expect((await b.searchText!(meta(), "chore", 10)).items).toEqual([]);
    expect(await b.searchText!(meta(), "   ", 10)).toEqual({ items: [], complete: true });
    const cut = await b.searchText!(meta(), "o", 2);
    expect(cut.items).toHaveLength(2);
    expect(cut.complete).toBe(false);
  });
});

describe("todoist, the traps of its API", () => {
  it("sends the token as a Bearer header, never in the URL", async () => {
    const { b, sim } = simulated();
    await b.verify(meta());
    await pass(b);
    expect(sim.calls.length).toBeGreaterThan(2);
    for (const c of sim.calls) {
      expect(c.authorization).toBe(`Bearer ${sim.token}`);
      expect(c.search).not.toContain(sim.token);
    }
  });

  it("knows whose the token is", async () => {
    const { b, sim } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: sim.me.id, name: "Mario Rossi", email: "mario@acme.example" });
  });

  it("a wrong token is auth (401); the old API's 403 on a bad token is auth too when verifying", async () => {
    const wrong = simulated({ token: "nottherighttoken" });
    expect(await errorOf(wrong.b.verify(meta()))).toMatchObject({ kind: "auth", status: 401 });
    expect(await errorOf(pass(wrong.b))).toMatchObject({ kind: "auth" });
    const old = simulated();
    old.sim.state.badTokenStatus = 403;
    old.sim.revoke();
    expect(await errorOf(old.b.verify(meta()))).toMatchObject({ kind: "auth", status: 403 });
    const revoked = simulated();
    revoked.sim.revoke();
    expect(await errorOf(revoked.b.verify(meta()))).toMatchObject({ kind: "auth" });
  });

  it("a project the user left is a 403: forbidden to act on, and not there for lookups; the pass no longer sees it", async () => {
    const { b, sim } = simulated();
    const ref = refOf(LOGIN);
    sim.outside.leaveProject("Acme Web");
    expect(await b.getIssue(meta(), ref)).toBeNull();
    expect((await b.findIssue(meta(), { key: LOGIN })).kind).toBe("none");
    expect(await errorOf(b.comments!.list(meta(), ref))).toMatchObject({ kind: "forbidden", status: 403 });
    expect(await errorOf(b.transitions!.list!(meta(), ref))).toMatchObject({ kind: "notFound" });
    expect(keys((await pass(b)).items)).toEqual([CERTS, WATER].sort());
    expect((await b.verify(meta())).remoteId).toBe(sim.me.id);
  });

  it("a malformed id is 400 (none when looked up), a deleted task a 404, a deleted project's task too", async () => {
    const { b, sim } = simulated();
    expect((await b.findIssue(meta(), { key: "x" })).kind).toBe("none");
    expect(await b.getIssue(meta(), { remoteId: "not an id", key: "x" })).toBeNull();
    expect(await errorOf(b.comments!.list(meta(), { remoteId: "not an id", key: "x" }))).toMatchObject({ kind: "invalid", status: 400 });
    expect((await b.findIssue(meta(), { key: "6NoSuchTask0001" })).kind).toBe("none");
    sim.outside.delete(ANNA);
    expect(await errorOf(b.comments!.list(meta(), refOf(ANNA)))).toMatchObject({ kind: "notFound", status: 404 });
    sim.outside.deleteProject("Operations");
    sim.add("Acme Web", "Moves soon", { id: "6MovesSoon00007" });
    expect(await b.getIssue(meta(), refOf("6MovesSoon00007"))).not.toBeNull();
  });

  it("a rate limit is a 429 whose body says how long to wait (no rate-limit headers), and the budget is 450 calls", async () => {
    const { b, sim } = simulated();
    sim.state.budget = 3;
    const errors: unknown[] = [];
    for (let n = 0; n < 5; n++) errors.push(await errorOf(b.verify(meta())));
    expect(errors.slice(0, 3)).toEqual([null, null, null]);
    expect(errors[3]).toMatchObject({ kind: "rateLimit", status: 429, transient: true, rateLimit: { retryAfterMs: 17_000, remaining: 0 } });
    expect(BUDGET).toBe(450);

    const other = simulated();
    other.sim.exhaust();
    expect(await errorOf(other.b.verify(meta()))).toMatchObject({ kind: "rateLimit" });
    other.sim.refill();
    expect((await other.b.verify(meta())).name).toBe("Mario Rossi");

    // A header alone, or nothing: a minute.
    vi.stubGlobal("fetch", async () => new Response("slow down", { status: 429, headers: { "retry-after": "5" } }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 5000 } });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 429 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 60_000 } });
  });

  it("a server error is unavailable, and an answer that isn't JSON is incompatible", async () => {
    const { b } = simulated();
    vi.stubGlobal("fetch", async () => new Response("Todoist is down for maintenance", { status: 503 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "unavailable", message: expect.stringContaining("maintenance") });
    vi.stubGlobal("fetch", async () => new Response("<html>hello</html>", { status: 200 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "incompatible" });
  });

  it("writes answer 204 with no body: nothing is parsed from them", async () => {
    const { b, sim } = simulated();
    const closing = sim.fetch;
    let status = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const res = await closing(url, init);
      if (init?.method === "POST" && String(url).endsWith("/close")) status = res.status;
      return res;
    });
    await b.transitions!.apply!(meta(), refOf(EXPORT), "complete", {});
    expect(status).toBe(204);
  });
});

describe("todoist webhooks", () => {
  const secret = "client-secret-0123";

  it("accepts a delivery signed with the app's client secret, and reads its id, time and event", () => {
    const { sim } = simulated();
    const d = sim.webhook("item:updated", { id: LOGIN }, { secret, deliveryId: "dl-1", triggeredAt: "2026-10-21T10:00:00.000000Z" });
    expect(todoistWebhook.verify({ secret, rawBody: d.rawBody, headers: d.headers })).toBe(true);
    expect(todoistWebhook.verify({ secret, rawBody: d.rawBody, headers: new Headers(d.headers) })).toBe(true);
    expect(todoistWebhook.verify({ secret, rawBody: d.rawBody, headers: { "X-Todoist-Hmac-SHA256": d.headers["x-todoist-hmac-sha256"] } })).toBe(true);
    expect(todoistWebhook.sentAt(d.rawBody)).toBe(Date.parse("2026-10-21T10:00:00.000Z"));
    expect(todoistWebhook.event(d.rawBody)).toBe("issueChanged");
    for (const [name, event] of [["item:added", "issueChanged"], ["item:completed", "issueChanged"], ["item:uncompleted", "issueChanged"], ["item:deleted", "issueRemoved"], ["note:added", "commentAdded"], ["note:updated", null], ["project:added", null]] as const) {
      expect(todoistWebhook.event(sim.webhook(name, {}, { secret }).rawBody)).toBe(event);
    }
    expect(todoistWebhook.sentAt("not json")).toBeNull();
    expect(todoistWebhook.sentAt("{}")).toBeNull();
    expect(todoistWebhook.event("[]")).toBeNull();
  });

  it("refuses a wrong secret, a body changed after signing, and a missing or malformed signature", () => {
    const { sim } = simulated();
    const wrong = sim.webhook("item:updated", {}, { secret, signedWith: "other" });
    expect(todoistWebhook.verify({ secret, rawBody: wrong.rawBody, headers: wrong.headers })).toBe(false);
    const ok = sim.webhook("item:updated", {}, { secret });
    expect(todoistWebhook.verify({ secret, rawBody: ok.rawBody.replace("item:updated", "item:deleted"), headers: ok.headers })).toBe(false);
    expect(todoistWebhook.verify({ secret, rawBody: ok.rawBody, headers: {} })).toBe(false);
    expect(todoistWebhook.verify({ secret, rawBody: ok.rawBody, headers: { "x-todoist-hmac-sha256": "zz" } })).toBe(false);
    expect(todoistWebhook.verify({ secret: "", rawBody: ok.rawBody, headers: ok.headers })).toBe(false);
  });

  it("the contract's check takes the stored secret as is, and the delivery id from its header", () => {
    const { sim } = simulated();
    const d = sim.webhook("note:added", {}, { secret, deliveryId: "dl-9" });
    const req = { headers: d.headers, body: d.rawBody };
    expect(todoistProvider.webhook!.verify(req, secret)).toBe(true);
    expect(todoistProvider.webhook!.verify(req, "other")).toBe(false);
    expect(todoistProvider.webhook!.verify(req, "")).toBe(false);
    expect(todoistProvider.webhook!.deliveryId(req)).toBe("dl-9");
    expect(todoistProvider.webhook!.deliveryId({ headers: {}, body: d.rawBody })).toBeNull();
    expect(todoistProvider.webhook!.sentAt!(req)).toBeGreaterThan(0);
  });
});
