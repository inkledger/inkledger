import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { instant, markdown, timeZone } from "@contracts/values";
import { toRichDoc } from "../core/richtext";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import type { ActiveWorkflowSource } from "../types";
import { clickupSimulator, defaultStatuses, type SimTask } from "./simulator";
import { clickupProvider, clickupWebhook, previewOf, toClickUpText } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "198.51.100.7", family: 4 }]),
}));

// Entries are read in a window back from now: the conformance suite logs on a fixed day, so "now" is fixed too.
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const DAY = 86_400_000;
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

type Sim = ReturnType<typeof clickupSimulator>;

function simulated(o: { options?: unknown; token?: string; customIds?: boolean; zone?: string } = {}) {
  const sim = clickupSimulator();
  if (o.customIds) sim.main.customIds = true;
  const backlog = sim.list("Backlog", { folder: "Website" });
  const inbox = sim.list("Inbox");
  sim.add("Login fails on Safari", { list: backlog, description: "Steps", due: sim.dueOn("2026-11-05", "Europe/Rome") });
  sim.add("Export to CSV", { list: backlog, status: "in progress", tags: ["bug"], priority: 1, estimate: 7_200_000 });
  sim.add("Rate limit headers", { list: inbox });
  // Someone else's, and one I wrote for someone else: not assigned to me.
  sim.add("Anna's", { list: backlog, assignees: [sim.anna.id] });
  sim.add("Delegated", { list: backlog, assignees: [sim.anna.id], author: sim.me.id });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 9,
    userId: 1,
    type: "clickup" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: String(sim.me.id),
    options: o.options ?? {},
    timeZone: timeZone(o.zone ?? "Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, backlog, inbox, conn, b: bindTracker(clickupProvider, conn) };
}

trackerConformance("clickup (simulated)", async () => {
  const { conn, sim } = simulated();
  return { provider: clickupProvider, conn, key: sim.keyOf(sim.tasks[0]), writable: true, url: `${sim.web}/t/${sim.tasks[0].id}` };
});

trackerConformance("clickup (simulated, custom task ids)", async () => {
  const { conn, sim } = simulated({ customIds: true });
  return { provider: clickupProvider, conn, key: sim.keyOf(sim.tasks[0]), writable: true, url: `${sim.web}/t/${sim.main.id}/${sim.tasks[0].customId}` };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
const pass = (b: ReturnType<typeof simulated>["b"], since: Parameters<typeof b.listChanged>[1]["since"] = null) => readPass((q) => b.listChanged(meta(), q), since);
const ref = (sim: Sim, t: SimTask) => ({ remoteId: t.id, key: sim.keyOf(t) });
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; rateLimit?: { retryAfterMs?: number; remaining?: number }; message: string });
const raw = (sim: Sim, path: string, init: { method?: string; data?: unknown; auth?: string } = {}) =>
  sim.fetch(`${sim.apiBase}${path}`, { method: init.method ?? "GET", headers: { Authorization: init.auth ?? sim.token }, ...(init.data === undefined ? {} : { body: JSON.stringify(init.data) }) });
const bodyOf = async (r: Response) => (await r.json()) as Record<string, unknown>;
const names = (items: { title: string }[]) => items.map((i) => i.title);

describe("clickup, tasks", () => {
  it("lists what is assigned to the user: string ids, CU- keys, dates from millisecond strings, the list as container", async () => {
    const { b, sim } = simulated();
    const all = await pass(b);
    expect(all.items.map((i) => [i.key, i.title, i.status.name, i.status.category, i.container.name, i.container.kind])).toEqual([
      [`CU-${sim.tasks[0].id}`, "Login fails on Safari", "to do", "todo", "Backlog", "list"],
      [`CU-${sim.tasks[1].id}`, "Export to CSV", "in progress", "doing", "Backlog", "list"],
      [`CU-${sim.tasks[2].id}`, "Rate limit headers", "to do", "todo", "Inbox", "list"],
    ]);
    const [first, second, third] = all.items;
    expect(first).toMatchObject({ remoteId: sim.tasks[0].id, due: "2026-11-05", url: `${sim.web}/t/${sim.tasks[0].id}`, type: { id: "task", level: "standard" }, container: { group: "Website" } });
    expect(typeof first.remoteId).toBe("string");
    expect(first.createdAt).toBe(sim.tasks[0].created);
    expect(first.assignees[0]).toMatchObject({ remoteId: String(sim.me.id), name: "Mario Rossi", avatarUrl: expect.stringContaining("1234567") });
    expect(second).toMatchObject({ labels: ["bug"], priority: { name: "high", rank: 1 }, estimateSeconds: 7200 });
    // A list outside any folder has a hidden one: no group.
    expect(third.container.group).toBeNull();
  });

  it("asks for the markdown description: ClickUp gives it only then", async () => {
    const { b, sim } = simulated();
    const bare = await bodyOf(await raw(sim, `/task/${sim.tasks[0].id}`));
    expect(bare).not.toHaveProperty("markdown_description");
    const full = await bodyOf(await raw(sim, `/task/${sim.tasks[0].id}?include_markdown_description=true`));
    expect(full.markdown_description).toBe("Steps");
    expect(await b.description!(meta(), ref(sim, sim.tasks[0]))).toEqual({ kind: "text", format: "gfm", text: "Steps" });
    expect(await b.description!(meta(), ref(sim, sim.tasks[1]))).toBeNull();
  });

  it("closed tasks and subtasks are left out of the team list unless asked for; a first read asks for both", async () => {
    const { b, sim, backlog } = simulated();
    const ws = sim.main.id;
    const closed = sim.add("Shipped", { list: backlog });
    sim.outside.status(closed, "complete");
    const sub = sim.add("A step", { parent: sim.tasks[0] });
    const plain = (await bodyOf(await raw(sim, `/team/${ws}/task?assignees[]=${sim.me.id}`))) as { tasks: { name: string }[] };
    expect(plain.tasks.map((t) => t.name)).not.toContain("Shipped");
    expect(plain.tasks.map((t) => t.name)).not.toContain("A step");
    const all = await pass(b);
    expect(names(all.items)).toEqual(expect.arrayContaining(["Shipped", "A step"]));
    expect(all.items.find((i) => i.title === "Shipped")?.status).toMatchObject({ name: "complete", category: "done" });
    expect(all.items.find((i) => i.title === "A step")).toMatchObject({ type: { level: "sub" }, parent: { remoteId: sim.tasks[0].id }, remoteId: sub.id });
    expect(new Set(all.items.map((i) => i.remoteId)).size).toBe(all.items.length);
  });

  it("a first read takes the tasks closed lately, not those closed long ago", async () => {
    const { b, sim, backlog } = simulated();
    const old = sim.add("Closed long ago", { list: backlog });
    sim.outside.status(old, "complete");
    old.updated = NOW - 90 * DAY;
    const recent = sim.add("Closed this week", { list: backlog });
    sim.outside.status(recent, "complete");
    recent.updated = NOW - 2 * DAY;
    const first = await pass(b);
    expect(names(first.items)).toContain("Closed this week");
    expect(names(first.items)).not.toContain("Closed long ago");
    // A later pass asks for everything changed: the old one comes if it is touched.
    sim.outside.retitle(old, "Closed long ago, reopened for notes");
    expect(names((await pass(b, first.checkpoint)).items)).toEqual(["Closed long ago, reopened for notes"]);
  });

  it("pages are zero-based, 100 a page, and the last says so (exactly 100 is one page)", async () => {
    const { b, sim, backlog } = simulated();
    for (let n = 0; n < 230; n++) sim.add(`Bulk ${String(n)}`, { list: backlog });
    const all = await pass(b);
    expect(all.items.length).toBe(233);
    expect(new Set(all.items.map((i) => i.remoteId)).size).toBe(233);
    // Three pages of open tasks, then three of what changed lately (ClickUp can't ask for closed ones only).
    expect(all.pages).toBe(6);
    const exact = simulated();
    for (let n = 0; n < 97; n++) exact.sim.add(`Bulk ${String(n)}`, { list: exact.backlog });
    const r = await pass(exact.b);
    expect(r.items.length).toBe(100);
    expect(r.pages).toBe(2);
    const edge = (await bodyOf(await raw(exact.sim, `/team/${exact.sim.main.id}/task?assignees[]=${exact.sim.me.id}&page=0`))) as { last_page: boolean };
    expect(edge.last_page).toBe(true);
    expect(((await bodyOf(await raw(exact.sim, `/team/${exact.sim.main.id}/task?assignees[]=${exact.sim.me.id}&page=1`))) as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it("reads only what changed since its checkpoint; date_updated_gt is exclusive, so the pass overlaps", async () => {
    const { b, sim } = simulated();
    const all = await pass(b);
    const t = sim.tasks[0];
    const exclusive = (await bodyOf(await raw(sim, `/team/${sim.main.id}/task?date_updated_gt=${t.updated}`))) as { tasks: { id: string }[] };
    expect(exclusive.tasks.map((x) => x.id)).not.toContain(t.id);
    const inclusive = (await bodyOf(await raw(sim, `/team/${sim.main.id}/task?date_updated_gt=${t.updated - 1}`))) as { tasks: { id: string }[] };
    expect(inclusive.tasks.map((x) => x.id)).toContain(t.id);
    // Tasks quiet for an hour: only the one touched since is read again.
    for (const x of sim.tasks) x.updated = NOW - 3_600_000;
    sim.outside.retitle(sim.tasks[1], "Export to CSV, v2");
    expect(names((await pass(b, all.checkpoint)).items)).toEqual(["Export to CSV, v2"]);
    expect((await pass(b, (await pass(b, all.checkpoint)).checkpoint)).items.length).toBeLessThanOrEqual(1);
  });

  it("a due date is an instant: a day set without a time is 04:00 where it was set, read as the user's day; a timed one falls on the user's day", async () => {
    const auckland = simulated({ zone: "Pacific/Auckland" });
    const day = auckland.sim.add("Day only", { due: auckland.sim.dueOn("2026-11-05", "Pacific/Auckland") });
    // Read as a UTC date it would be the day before.
    expect(new Date(day.due!.ms).toISOString().slice(0, 10)).toBe("2026-11-04");
    expect((await auckland.b.getIssue(meta(), ref(auckland.sim, day)))?.due).toBe("2026-11-05");
    const rome = simulated();
    const late = rome.sim.add("Late", { due: rome.sim.dueAt("2026-11-05T23:30:00.000Z") });
    expect((await rome.b.getIssue(meta(), ref(rome.sim, late)))?.due).toBe("2026-11-06");
    const la = simulated({ zone: "America/Los_Angeles" });
    const same = la.sim.add("Late", { due: la.sim.dueAt("2026-11-05T23:30:00.000Z") });
    expect((await la.b.getIssue(meta(), ref(la.sim, same)))?.due).toBe("2026-11-05");
    expect((await rome.b.getIssue(meta(), ref(rome.sim, rome.sim.tasks[0])))?.due).toBe("2026-11-05");
  });

  it("a task moved to another list keeps its id and key; the container follows", async () => {
    const { b, sim, inbox } = simulated();
    const t = sim.tasks[0];
    const before = await b.getIssue(meta(), ref(sim, t));
    sim.outside.moveToList(t, inbox);
    const after = await b.getIssue(meta(), ref(sim, t));
    expect(after).toMatchObject({ remoteId: before!.remoteId, key: before!.key, container: { remoteId: inbox.id, name: "Inbox" } });
    sim.outside.renameList(inbox, "Triage");
    expect((await b.getIssue(meta(), ref(sim, t)))?.container.name).toBe("Triage");
  });

  it("a deleted task is a 404: null where a lookup asks, notFound where an operation needs it", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[2];
    sim.outside.delete(t);
    expect(await b.getIssue(meta(), ref(sim, t))).toBeNull();
    expect((await b.findIssue(meta(), { key: sim.keyOf(t) })).kind).toBe("none");
    expect(await errorOf(b.comments!.list(meta(), ref(sim, t)))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.watch!(meta(), ref(sim, t), true))).toMatchObject({ kind: "notFound" });
    expect(names((await pass(b)).items)).not.toContain("Rate limit headers");
  });

  it("a list the user lost is a 401 about the team, not a bad token: null, notFound, never auth", async () => {
    const { b, sim, backlog } = simulated();
    const t = sim.tasks[0];
    sim.outside.access(backlog, false);
    const direct = await raw(sim, `/task/${t.id}`);
    expect(direct.status).toBe(401);
    expect(await bodyOf(direct)).toMatchObject({ ECODE: "OAUTH_027" });
    expect(await b.getIssue(meta(), ref(sim, t))).toBeNull();
    expect(await errorOf(b.transitions!.list!(meta(), ref(sim, t)))).toMatchObject({ kind: "notFound" });
    expect(names((await pass(b)).items)).toEqual(["Rate limit headers"]);
    // The token is fine.
    expect((await b.verify(meta())).remoteId).toBe(String(sim.me.id));
  });

  it("reads one workspace or all of them", async () => {
    const { b, sim, conn } = simulated();
    const side = sim.workspace("Side");
    sim.add("In the side workspace", { list: sim.list("Side list", { team: side }) });
    expect(names((await pass(b)).items)).toContain("In the side workspace");
    const only = bindTracker(clickupProvider, { ...conn, options: { workspace: sim.main.id } });
    expect(names((await pass(only)).items)).not.toContain("In the side workspace");
    const wrong = bindTracker(clickupProvider, { ...conn, options: { workspace: "123" } });
    expect(await errorOf(pass(wrong))).toMatchObject({ kind: "invalid" });
    expect(() => bindTracker(clickupProvider, { ...conn, options: { workspace: "not digits" } })).toThrow();
  });
});

describe("clickup, keys and links", () => {
  it("a default key is CU- and the id; a custom id replaces it when the workspace has them", async () => {
    const plain = simulated();
    const customs = simulated({ customIds: true });
    expect(plain.sim.keyOf(plain.sim.tasks[0])).toBe(`CU-${plain.sim.tasks[0].id}`);
    expect(customs.sim.keyOf(customs.sim.tasks[0])).toBe("ENG-1");
    const all = await pass(customs.b);
    expect(all.items.map((i) => i.key)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    expect(all.items[0].remoteId).toBe(customs.sim.tasks[0].id);
  });

  it("a custom id works only with custom_task_ids=true and the team; the plain id only without", async () => {
    const { sim, b } = simulated({ customIds: true });
    const t = sim.tasks[0];
    expect((await raw(sim, `/task/ENG-1`)).status).toBe(404);
    expect((await raw(sim, `/task/ENG-1?custom_task_ids=true`)).status).toBe(400);
    expect((await raw(sim, `/task/ENG-1?custom_task_ids=true&team_id=${sim.main.id}`)).status).toBe(200);
    expect((await raw(sim, `/task/${t.id}?custom_task_ids=true&team_id=${sim.main.id}`)).status).toBe(404);
    expect((await raw(sim, `/task/${t.id}`)).status).toBe(200);
    // The adapter finds it by either, and by a link of each form.
    expect((await b.findIssue(meta(), { key: "eng-1" })).kind).toBe("found");
    expect((await b.findIssue(meta(), { remoteId: t.id })).kind).toBe("found");
    expect((await b.findIssue(meta(), { key: `CU-${t.id}` })).kind).toBe("found");
    expect((await b.findIssue(meta(), { key: "ENG-99" })).kind).toBe("none");
  });

  it("the same custom id in two workspaces is ambiguous, never a silent pick", async () => {
    const { sim, b } = simulated({ customIds: true });
    const side = sim.workspace("Side", { customIds: true, prefix: "ENG" });
    const other = sim.add("Same number elsewhere", { list: sim.list("Side list", { team: side }) });
    expect(other.customId).toBe("ENG-1");
    const found = await b.findIssue(meta(), { key: "ENG-1" });
    expect(found.kind).toBe("ambiguous");
    if (found.kind === "ambiguous") expect(found.candidates.map((c) => c.title).sort()).toEqual(["Login fails on Safari", "Same number elsewhere"]);
    // With the id it is one.
    expect((await b.findIssue(meta(), { remoteId: other.id })).kind).toBe("found");
    expect((await b.findIssue(meta(), { key: "ENG-1", remoteId: sim.tasks[0].id })).kind).toBe("found");
  });

  it("reads keys and links of the service, and refuses others", () => {
    const { b, sim } = simulated({ customIds: true });
    const t = sim.tasks[0];
    expect(b.parseRef("eng-12")).toEqual({ key: "ENG-12" });
    expect(b.parseRef(" cu-86C00001 ")).toEqual({ key: "CU-86c00001" });
    expect(b.parseRef(`${sim.web}/t/86c00001`)).toEqual({ key: "CU-86c00001", remoteId: "86c00001" });
    expect(b.parseRef(`${sim.web}/t/${t.team}/ENG-12`)).toEqual({ key: "ENG-12" });
    expect(b.parseRef(`${sim.web}/t/${t.team}/86c00001`)).toEqual({ key: "CU-86c00001", remoteId: "86c00001" });
    expect(b.parseRef(`${sim.web}/${t.team}/v/l/6-901-1`)).toBeNull();
    expect(b.parseRef("https://app.example.com/t/86c00001")).toBeNull();
    expect(b.normalizeKey("86c00001")).toBeNull();
    expect(b.normalizeKey("#12")).toBeNull();
  });
});

describe("clickup, statuses and transitions", () => {
  const shipping = [
    { status: "backlog", type: "open" as const, orderindex: 0, color: "#aaa" },
    { status: "in review", type: "custom" as const, orderindex: 1, color: "#bbb" },
    { status: "shipped", type: "done" as const, orderindex: 2, color: "#ccc" },
    { status: "closed", type: "closed" as const, orderindex: 3, color: "#ddd" },
  ];

  it("a status type is its category: open is todo, custom doing, done and closed done", async () => {
    const { b, sim } = simulated();
    const l = sim.list("Delivery", { statuses: shipping });
    const tasks = shipping.map((s) => sim.add(`In ${s.status}`, { list: l, status: s.status }));
    const got = await Promise.all(tasks.map((t) => b.getIssue(meta(), ref(sim, t))));
    expect(got.map((i) => [i!.status.name, i!.status.category, i!.status.nativeReason])).toEqual([
      ["backlog", "todo", "open"],
      ["in review", "doing", "custom"],
      ["shipped", "done", "done"],
      ["closed", "done", "closed"],
    ]);
    expect(got[2]!.status.source).toEqual({ kind: "itemState", containerRemoteId: l.id });
    expect(got[0]!.status.categoryOrigin).toEqual({ by: "native" });
  });

  it("statuses belong to the list: each list offers its own ways out, and a status of another list is refused", async () => {
    const { b, sim, backlog } = simulated();
    const l = sim.list("Delivery", { statuses: shipping });
    const mine = sim.add("In delivery", { list: l });
    const here = await b.transitions!.list!(meta(), ref(sim, sim.tasks[0]));
    const there = await b.transitions!.list!(meta(), ref(sim, mine));
    expect(here.map((t) => [t.name, t.to.category])).toEqual([
      ["in progress", "doing"],
      ["complete", "done"],
    ]);
    expect(there.map((t) => t.name)).toEqual(["in review", "shipped", "closed"]);
    expect(there.every((t) => t.requirements.length === 0)).toBe(true);
    expect(here[0].remoteUrl).toMatch(/^https:\/\/app\.clickup\.com\/t\//);
    const done = await b.transitions!.apply!(meta(), ref(sim, mine), "shipped", {});
    expect(done).toMatchObject({ status: { name: "shipped", category: "done" } });
    expect(mine.doneAt).not.toBeNull();
    // The sibling list has no "shipped".
    expect((await raw(sim, `/task/${sim.tasks[0].id}`, { method: "PUT", data: { status: "shipped" } })).status).toBe(400);
    expect(await errorOf(b.transitions!.apply!(meta(), ref(sim, sim.tasks[0]), "shipped", {}))).toMatchObject({ kind: "invalid" });
    expect(backlog.statuses).toBeNull();
  });

  it("sets a status by name, as the list writes it, and the closed type stamps date_closed", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const issue = await b.transitions!.apply!(meta(), ref(sim, t), "complete", {});
    expect(issue).toMatchObject({ status: { name: "complete", category: "done" }, statusChangedAt: t.closedAt });
    expect(t.closedAt).not.toBeNull();
    const back = await b.transitions!.apply!(meta(), ref(sim, t), "to do", {});
    expect(back?.status.category).toBe("todo");
    expect(t.closedAt).toBeNull();
  });

  it("lists the statuses of a list, or of the spaces when no list is named", async () => {
    const { b, sim } = simulated();
    const l = sim.list("Delivery", { statuses: shipping });
    const source = (containerRemoteId?: string): ActiveWorkflowSource => ({ kind: "itemState", transitions: "direct", ref: containerRemoteId ? { kind: "itemState", containerRemoteId } : { kind: "itemState" }, name: "" });
    expect((await b.statuses!(meta(), source(l.id))).map((s) => [s.name, s.category])).toEqual([
      ["backlog", "todo"],
      ["in review", "doing"],
      ["shipped", "done"],
      ["closed", "done"],
    ]);
    const spaces = await b.statuses!(meta(), source());
    expect(spaces.map((s) => s.name)).toEqual(defaultStatuses().map((s) => s.status));
    expect(spaces.every((s) => s.source.kind === "itemState")).toBe(true);
    expect(await b.statuses!(meta(), { kind: "boolean", transitions: "direct", reasons: false, ref: { kind: "boolean" }, name: "" })).toEqual([]);
  });
});

describe("clickup, comments", () => {
  it("reads blocks as rich bodies with a Markdown preview: marks, links, list lines, mentions", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const blocks = [
      { text: "Fixed " },
      { text: "the bug", attributes: { bold: true } },
      { text: " see " },
      { text: "docs", attributes: { link: "https://x.example" } },
      { text: "\n", attributes: {} },
      { text: "one" },
      { text: "\n", attributes: { list: { list: "bullet" } } },
      { text: "two" },
      { text: "\n", attributes: { list: { list: "bullet" } } },
      { type: "tag", user: { username: "Anna" } },
    ];
    sim.comment(t, { text: "Fixed the bug", blocks, by: sim.anna.id });
    const [c] = await b.comments!.list(meta(), ref(sim, t));
    expect(c).toMatchObject({ author: { remoteId: String(sim.anna.id), name: "Anna Bianchi" }, body: { kind: "structured", format: "rich", payload: blocks } });
    expect(c.body).toMatchObject({ preview: "Fixed **the bug** see [docs](https://x.example)\n- one\n- two\n@Anna" });
    expect(toRichDoc(c.body).blocks.length).toBeGreaterThan(0);
    expect(c.createdAt).not.toBeNull();
    expect(previewOf([{ text: "a\nb" }])).toBe("a\nb");
    expect(previewOf([{ text: "x" }, { text: "\n", attributes: { "code-block": { "code-block": "plain" } } }])).toBe("    x");
  });

  it("comes 25 at a time, newest first, paged with start and start_id: comments sharing a millisecond are none lost", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const base = NOW - 1_000_000;
    for (let n = 0; n < 60; n++) {
      const id = `46${String(n).padStart(5, "0")}`;
      t.comments.push({ id, date: base + Math.floor(n / 3) * 1000, by: sim.anna.id, blocks: [{ text: `c${String(n)}` }, { text: "\n", attributes: {} }], text: `c${String(n)}` });
    }
    const first = (await bodyOf(await raw(sim, `/task/${t.id}/comment`))) as { comments: { id: string; date: string }[] };
    expect(first.comments.length).toBe(25);
    expect(Number(first.comments[0].date)).toBeGreaterThanOrEqual(Number(first.comments[24].date));
    const calls = sim.state.calls;
    const got = await b.comments!.list(meta(), ref(sim, t));
    // The task, then 25 + 25 + 10.
    expect(sim.state.calls - calls).toBe(4);
    expect(got.map((c) => c.id).length).toBe(60);
    expect(new Set(got.map((c) => c.id)).size).toBe(60);
    expect(got.map((c) => (c.body.kind === "structured" ? c.body.preview : ""))).toEqual(Array.from({ length: 60 }, (_, n) => `c${String(n)}`));
  });

  it("writes plain text and says what the page loses; the answer is only an id, so the comment is read again", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const raw1 = await raw(sim, `/task/${t.id}/comment`, { method: "POST", data: { comment_text: "hi" } });
    expect(Object.keys(await bodyOf(raw1)).sort()).toEqual(["date", "hist_id", "id"]);
    const r = await b.comments!.add!(meta(), ref(sim, t), markdown("Checked **twice**\n\n- a\n- b\n\nSee [docs](https://x.example)"), { idempotencyKey: "c1" });
    expect(r.comment).toBeNull();
    expect(r.warnings.map((w) => w.feature).sort()).toEqual(["link", "list", "strong"]);
    for (const w of r.warnings) expect(w).not.toHaveProperty("serverDetail");
    const mine = (await b.comments!.list(meta(), ref(sim, t))).at(-1)!;
    expect(mine.body).toMatchObject({ kind: "structured", preview: "Checked twice\n\n- a\n- b\n\nSee docs (https://x.example)" });
    expect(await errorOf(b.comments!.add!(meta(), ref(sim, t), markdown("   "), { idempotencyKey: "c2" }))).toMatchObject({ kind: "invalid" });
  });

  it("turns Markdown into the text ClickUp takes", () => {
    expect(toClickUpText("plain")).toEqual({ text: "plain", warnings: [] });
    const r = toClickUpText("# Title\n\n> quoted\n\n`code` and *soft* and __hard__\n\n```\nx = 1\n```\n\n| a |\n\n![pic](https://x.example/p.png)");
    expect(r.text).toBe("Title\n\n> quoted\n\ncode and soft and hard\n\nx = 1\n\n| a |\n\npic (https://x.example/p.png)");
    expect(r.warnings.map((w) => w.feature).sort()).toEqual(["code", "codeBlock", "emphasis", "heading", "image", "quote", "strong", "table"]);
  });
});

describe("clickup, time", () => {
  const session = (secondsAgo: number, seconds: number) => ({ kind: "session" as const, start: instant(NOW - secondsAgo * 1000), seconds });

  it("logs a start and a duration in milliseconds; the update answers a list; deleting twice is a success", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const r = ref(sim, t);
    const made = await b.worklogs!.create!(meta(), r, { time: session(3600, 5400), comment: "debugging", billable: true }, { idempotencyKey: "k1" });
    expect(made).toMatchObject({ span: { kind: "session", start: NOW - 3_600_000, seconds: 5400 }, comment: "debugging", billable: true, authorRemoteId: String(sim.me.id), issue: { remoteId: t.id, key: `CU-${t.id}` }, editable: { update: true, delete: true } });
    expect(sim.entries[0]).toMatchObject({ duration: 5_400_000, start: NOW - 3_600_000, task: t.id });
    const sent = await bodyOf(await raw(sim, `/team/${sim.main.id}/time_entries/${made.remoteId}`, { method: "PUT", data: { description: "x" } }));
    expect(Array.isArray(sent.data)).toBe(true);
    const changed = await b.worklogs!.update!(meta(), r, made.remoteId, { time: session(3600, 1800), comment: "changed", billable: false }, {});
    expect(changed).toMatchObject({ span: { seconds: 1800 }, comment: "changed", billable: false });
    expect((await b.worklogs!.get!(meta(), r, made.remoteId))?.comment).toBe("changed");
    expect((await b.getIssue(meta(), r))?.spentSeconds).toBe(1800);
    await b.worklogs!.delete!(meta(), r, made.remoteId, {});
    await b.worklogs!.delete!(meta(), r, made.remoteId, {});
    expect(sim.entries.length).toBe(0);
    expect(await b.worklogs!.get!(meta(), r, made.remoteId)).toBeNull();
    expect(await errorOf(b.worklogs!.create!(meta(), r, { time: { kind: "date", date: "2026-10-14" as never, seconds: 60 }, comment: "" }, { idempotencyKey: "k2" }))).toMatchObject({ kind: "invalid" });
  });

  it("lists an issue's time over all dates: without dates ClickUp gives only the last 30 days", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const old = sim.entry(t, { start: NOW - 45 * DAY, duration: 3_600_000, description: "long ago" });
    const recent = sim.entry(t, { start: NOW - DAY, duration: 1_800_000 });
    const bare = (await bodyOf(await raw(sim, `/team/${sim.main.id}/time_entries?task_id=${t.id}`))) as { data: { id: string }[] };
    expect(bare.data.map((e) => e.id)).toEqual([recent.id]);
    expect((await b.worklogs!.list(meta(), ref(sim, t))).map((w) => w.remoteId)).toEqual([old.id, recent.id]);
  });

  it("skips a running timer (a negative duration) and reads time on no task with no issue", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const running = sim.entry(t, { start: NOW - 600_000, duration: -1 });
    const loose = sim.entry(null, { start: NOW - 7_200_000, duration: 900_000, description: "meeting" });
    expect(running.duration).toBeLessThan(0);
    expect(await b.worklogs!.list(meta(), ref(sim, t))).toEqual([]);
    expect((await b.getIssue(meta(), ref(sim, t)))?.spentSeconds).toBeNull();
    const feed = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    expect(feed.items.map((w) => [w.remoteId, w.issue])).toEqual([[loose.id, null]]);
  });

  it("the feed is a 30 day window on the start, taking what changed since the checkpoint", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    const quiet = sim.entry(t, { start: NOW - 2 * DAY, duration: 600_000 });
    quiet.at = NOW - 3_600_000;
    const edited = sim.entry(t, { start: NOW - 3 * DAY, duration: 600_000 });
    edited.at = NOW - 3_600_000;
    const beyond = sim.entry(t, { start: NOW - 45 * DAY, duration: 600_000 });
    beyond.at = NOW - 3_600_000;
    const first = await readPass((q) => b.worklogs!.changed!(meta(), q), null);
    expect(first.items.map((w) => w.remoteId).sort()).toEqual([edited.id, quiet.id].sort());
    expect(first.gone).toEqual([]);
    sim.outside.editEntry(edited, { duration: 1_200_000 });
    const later = await readPass((q) => b.worklogs!.changed!(meta(), q), first.checkpoint);
    expect(later.items.map((w) => [w.remoteId, w.span.seconds, w.updatedAt])).toEqual([[edited.id, 1200, edited.at]]);
    // An old entry edited is outside the window (it is by start): the period reconcile finds it.
    sim.outside.editEntry(beyond, { duration: 60_000 });
    expect((await readPass((q) => b.worklogs!.changed!(meta(), q), first.checkpoint)).items.map((w) => w.remoteId)).toEqual([edited.id]);
    expect((await b.worklogs!.list(meta(), ref(sim, t))).map((w) => w.remoteId)).toContain(beyond.id);
    // A removal is not in the feed.
    sim.outside.deleteEntry(quiet);
    expect((await readPass((q) => b.worklogs!.changed!(meta(), q), null)).items.map((w) => w.remoteId)).toEqual([edited.id]);
    expect(b.capabilities.time).toMatchObject({ entries: { feed: { kind: "window", by: "updatedAt" }, reconcile: { kind: "period" } } });
  });

  it("without dates the entries list is the last 30 days of the user's own", async () => {
    const { sim } = simulated();
    const t = sim.tasks[0];
    sim.entry(t, { start: NOW - DAY, duration: 60_000 });
    sim.entry(t, { start: NOW - 31 * DAY, duration: 60_000 });
    sim.entry(t, { start: NOW - DAY, duration: 60_000, user: sim.anna.id });
    const r = (await bodyOf(await raw(sim, `/team/${sim.main.id}/time_entries`))) as { data: { user: { id: number }; duration: string; start: string }[] };
    expect(r.data.length).toBe(1);
    expect(r.data[0]).toMatchObject({ duration: "60000", start: String(NOW - DAY) });
    expect(r.data[0].user.id).toBe(sim.me.id);
  });

  it("a workspace with the Time Tracking ClickApp off refuses (forbidden); the feed still reads the others", async () => {
    const { b, sim } = simulated();
    const side = sim.workspace("Side", { timeTracking: false });
    const sideTask = sim.add("Side task", { list: sim.list("Side list", { team: side }) });
    const mine = sim.entry(sim.tasks[0], { start: NOW - DAY, duration: 60_000 });
    expect(await errorOf(b.worklogs!.list(meta(), ref(sim, sideTask)))).toMatchObject({ kind: "forbidden" });
    expect(await errorOf(b.worklogs!.create!(meta(), ref(sim, sideTask), { time: session(60, 60), comment: "" }, { idempotencyKey: "k" }))).toMatchObject({ kind: "forbidden" });
    expect((await readPass((q) => b.worklogs!.changed!(meta(), q), null)).items.map((w) => w.remoteId)).toEqual([mine.id]);
  });

  it("refuses a pass cut off by a checkpoint of another stream", async () => {
    const { b } = simulated();
    const issues = await pass(b);
    expect(await errorOf(b.worklogs!.changed!(meta(), { since: issues.checkpoint, page: null }))).toMatchObject({ kind: "invalidCheckpoint" });
  });
});

describe("clickup, watching and searching", () => {
  it("watches and unwatches through the task's watchers; again is what was asked", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    await b.watch!(meta(), ref(sim, t), true);
    await b.watch!(meta(), ref(sim, t), true);
    expect([...t.watchers]).toEqual([sim.me.id]);
    await b.watch!(meta(), ref(sim, t), false);
    await b.watch!(meta(), ref(sim, t), false);
    expect(t.watchers.size).toBe(0);
  });

  it("has no server side text search: it matches over the newest tasks and says when it stopped short", async () => {
    const { b, sim, backlog } = simulated();
    const found = await b.searchText!(meta(), "safari", 10);
    expect(names(found.items)).toEqual(["Login fails on Safari"]);
    expect(found.complete).toBe(true);
    expect((await b.searchText!(meta(), "e", 2)).complete).toBe(false);
    // 520 newer tasks push the old one past the five pages read.
    for (let n = 0; n < 520; n++) sim.add(`Filler ${String(n)}`, { list: backlog });
    const cut = await b.searchText!(meta(), "safari", 10);
    expect(cut.items).toEqual([]);
    expect(cut.complete).toBe(false);
    expect(names((await b.searchText!(meta(), "Filler 519", 10)).items)).toEqual(["Filler 519"]);
  });
});

describe("clickup, webhooks", () => {
  const secret = "webhook-secret-from-creation";

  it("accepts a delivery signed with the webhook's secret (X-Signature) and refuses any other", () => {
    const { sim } = simulated();
    const d = sim.webhook("taskUpdated", "86c00001", { secret });
    expect(clickupWebhook.verify(d.headers, d.rawBody, secret)).toBe(true);
    expect(clickupProvider.webhook!.verify({ headers: d.headers, body: d.rawBody }, secret)).toBe(true);
    const wrong = sim.webhook("taskUpdated", "86c00001", { secret, signedWith: "other" });
    expect(clickupWebhook.verify(wrong.headers, wrong.rawBody, secret)).toBe(false);
    expect(clickupWebhook.verify(d.headers, d.rawBody.replace("taskUpdated", "taskDeleted"), secret)).toBe(false);
    expect(clickupWebhook.verify({}, d.rawBody, secret)).toBe(false);
    expect(clickupWebhook.verify({ "x-signature": "zz" }, d.rawBody, secret)).toBe(false);
    expect(clickupWebhook.verify(d.headers, d.rawBody, "")).toBe(false);
  });

  it("has no delivery id of its own: the webhook and its first history item make one; a delivery is dated by its latest item", () => {
    const { sim } = simulated();
    const d = sim.webhook("taskUpdated", "86c00001", { secret, ageMs: 5000, items: 2 });
    const id = clickupProvider.webhook!.deliveryId({ headers: d.headers, body: d.rawBody });
    expect(id).toMatch(/^4b6bac1a-bc5a-4a32-9e2f-000000000001:\d+$/);
    expect(clickupWebhook.deliveryId(sim.webhook("taskUpdated", "86c00001", { secret }).rawBody)).not.toBe(id);
    expect(clickupWebhook.sentAt(d.rawBody)).toBe(NOW - 5000);
    expect(clickupProvider.webhook!.sentAt!({ headers: d.headers, body: d.rawBody })).toBe(NOW - 5000);
    expect(clickupWebhook.deliveryId(JSON.stringify({ webhook_id: "w", event: "taskDeleted", history_items: [] }))).toBeNull();
    expect(clickupWebhook.sentAt(JSON.stringify({ history_items: [] }))).toBeNull();
    expect(clickupWebhook.sentAt("not json")).toBeNull();
    expect(clickupWebhook.deliveryId("not json")).toBeNull();
  });

  it("names the declared events a delivery is", () => {
    const body = (event: string) => JSON.stringify({ event });
    expect(clickupWebhook.events(body("taskUpdated"))).toEqual(["issueChanged"]);
    expect(clickupWebhook.events(body("taskStatusUpdated"))).toEqual(["issueChanged"]);
    expect(clickupWebhook.events(body("taskMoved"))).toEqual(["issueChanged"]);
    expect(clickupWebhook.events(body("taskDeleted"))).toEqual(["issueRemoved"]);
    expect(clickupWebhook.events(body("taskCommentPosted"))).toEqual(["commentAdded"]);
    expect(clickupWebhook.events(body("taskTimeTrackedUpdated"))).toEqual(["worklogChanged", "worklogRemoved"]);
    expect(clickupWebhook.events(body("listCreated"))).toEqual([]);
    expect(clickupWebhook.events("nope")).toEqual([]);
  });
});

describe("clickup, errors and limits", () => {
  it("the token is the whole Authorization header: Bearer is refused, a bad token is auth (401)", async () => {
    const { sim, b } = simulated();
    const bearer = await raw(sim, "/user", { auth: `Bearer ${sim.token}` });
    expect(bearer.status).toBe(401);
    expect(await bodyOf(bearer)).toMatchObject({ ECODE: "OAUTH_025" });
    sim.state.auth.length = 0;
    await b.verify(meta());
    expect(sim.state.auth.length).toBe(1);
    expect(sim.state.auth.every((a) => a === sim.token)).toBe(true);
    const bad = simulated({ token: "wrong" });
    expect(await errorOf(bad.b.verify(meta()))).toMatchObject({ kind: "auth" });
  });

  it("a revoked token is auth on every call", async () => {
    const { b, sim } = simulated();
    expect((await b.verify(meta())).remoteId).toBe(String(sim.me.id));
    sim.revoke();
    expect(await errorOf(pass(b))).toMatchObject({ kind: "auth" });
    expect(await errorOf(b.getIssue(meta(), ref(sim, sim.tasks[0])))).toMatchObject({ kind: "auth" });
  });

  it("an exhausted quota is a wait until X-RateLimit-Reset (Unix seconds); there is no Retry-After", async () => {
    const { b, sim } = simulated();
    const limited = await (async () => {
      sim.exhaust();
      return raw(sim, "/user");
    })();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeNull();
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    const err = await errorOf(b.verify(meta()));
    expect(err).toMatchObject({ kind: "rateLimit", rateLimit: { remaining: 0 } });
    expect(err?.rateLimit?.retryAfterMs).toBeGreaterThan(25_000);
    expect(err?.rateLimit?.retryAfterMs).toBeLessThanOrEqual(31_000);
    sim.refill();
    expect((await b.verify(meta())).name).toBe("Mario Rossi");
  });

  it("knows who the token belongs to and reads the budget from the headers (100 a minute; more on larger plans)", async () => {
    const { b, sim } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: String(sim.me.id), name: "Mario Rossi", email: "mario@acme.example" });
    const probe = await b.probe(meta());
    expect(probe.rateLimit).toEqual({ perHour: 6000, origin: "detected" });
    expect(probe.activeSources).toEqual([expect.objectContaining({ kind: "itemState", transitions: "direct" })]);
    sim.state.limit = 1000;
    expect((await b.probe(meta())).rateLimit).toEqual({ perHour: 60_000, origin: "detected" });
  });

  it("a missing task is notFound where an operation needs it, null where a lookup asks; a server error is unavailable", async () => {
    const { b } = simulated();
    const ghost = { remoteId: "86czzzzzz", key: "CU-86czzzzzz" };
    expect(await b.getIssue(meta(), ghost)).toBeNull();
    expect(await errorOf(b.transitions!.list!(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.comments!.list(meta(), ghost))).toMatchObject({ kind: "notFound" });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ err: "Oops", ECODE: "X" }), { status: 503 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "unavailable" });
  });

  it("refuses a page token or checkpoint of another connection", async () => {
    const { b, conn } = simulated();
    const mine = (await pass(b)).checkpoint;
    const other = bindTracker(clickupProvider, { ...conn, id: 10 });
    expect(await errorOf(other.listChanged(meta(), { since: mine, page: null }))).toMatchObject({ kind: "invalidCheckpoint" });
  });
});
