import { describe, expect, it, vi } from "vitest";
import { timeZone } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import { plannerSimulator, type SimTask } from "./simulator";
import { plannerProvider } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "198.51.100.7", family: 4 }]),
}));

const COLUMNS = { options: { columns: { "To do": "todo", Doing: "doing", Review: "doing", Done: "done", "Won't do": "cancelled" } } };

function simulated(o: { options?: unknown; token?: string; zone?: string; pageSize?: number } = {}) {
  const sim = plannerSimulator(undefined, { pageSize: o.pageSize });
  const web = sim.plan("Website", { buckets: ["To do", "Doing", "Review", "Done", "Won't do"], categories: { category1: "Bug", category3: "Frontend" } });
  sim.add("Login fails on Safari", { plan: web, bucket: "To do", description: "Steps\r\nto reproduce", due: "2026-11-05T00:00:00Z", categories: ["category1", "category2"], priority: 1 });
  sim.add("Export to CSV", { plan: web, bucket: "Doing", percent: 50, priority: 3, categories: ["category3"] });
  sim.add("Rate limit headers", { plan: web, bucket: "Review", priority: 9 });
  // Someone else's: not assigned to me.
  sim.add("Anna's", { plan: web, assignees: [sim.anna] });
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 9,
    userId: 1,
    type: "planner" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: sim.me.id,
    options: o.options ?? {},
    timeZone: timeZone(o.zone ?? "Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: o.token ?? sim.token }),
  };
  return { sim, web, conn, b: bindTracker(plannerProvider, conn) };
}

const urlOf = (t: SimTask) => `https://planner.cloud.microsoft/webui/plan/${t.planId}/view/board/task/${t.id}`;

trackerConformance("planner (simulated)", async () => {
  const { conn, sim } = simulated();
  return { provider: plannerProvider, conn, key: sim.keyOf(sim.tasks[0]), writable: true, url: urlOf(sim.tasks[0]) };
});

trackerConformance("planner (simulated, buckets as statuses)", async () => {
  const { conn, sim } = simulated(COLUMNS);
  return { provider: plannerProvider, conn, key: sim.keyOf(sim.tasks[0]), writable: true, url: urlOf(sim.tasks[0]) };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });
type Simulated = ReturnType<typeof simulated>;
const pass = (b: Simulated["b"], since: Parameters<Simulated["b"]["listChanged"]>[1]["since"] = null) => readPass((q) => b.listChanged(meta(), q), since);
const ref = (t: SimTask) => ({ remoteId: t.id, key: `PLANNER-${t.id}` });
const errorOf = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { kind?: string; rateLimit?: { retryAfterMs?: number; remaining?: number }; message: string });
const raw = (sim: ReturnType<typeof plannerSimulator>, path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  sim.fetch(`${sim.apiBase}${path}`, { method: init.method ?? "GET", headers: { Authorization: `Bearer ${sim.token}`, ...init.headers }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });

describe("planner, tasks", () => {
  it("lists what is assigned to the user, keyed by id; the id keeps its case, its _ and its -", async () => {
    const { b, sim } = simulated();
    const all = await pass(b);
    expect(all.items.map((i) => [i.key, i.title, i.status.name, i.status.category, i.container.kind, i.container.name])).toEqual([
      [`PLANNER-${sim.tasks[0].id}`, "Login fails on Safari", "Not started", "todo", "plan", "Website"],
      [`PLANNER-${sim.tasks[1].id}`, "Export to CSV", "In progress", "doing", "plan", "Website"],
      [`PLANNER-${sim.tasks[2].id}`, "Rate limit headers", "Not started", "todo", "plan", "Website"],
    ]);
    const [first] = all.items;
    expect(first.remoteId).toMatch(/^[A-Za-z0-9_-]{28}$/);
    expect(first.remoteId).toMatch(/[A-Z]/);
    expect(first.remoteId).toMatch(/[a-z]/);
    expect(first.remoteId).toMatch(/[_-]/);
    expect(first).toMatchObject({ url: urlOf(sim.tasks[0]), type: { id: "task", level: "standard" }, container: { remoteId: sim.tasks[0].planId, key: "Website" }, reporter: { name: "Mario Rossi" } });
    expect(first.assignees.map((a) => [a.remoteId, a.name])).toEqual([[sim.me.id, "Mario Rossi"]]);
    // The prefix of a typed key is any case, the id is not.
    expect(b.normalizeKey(`planner-${first.remoteId}`)).toBe(first.key);
  });

  it("names the labels of the plan; an unnamed one reads as its colour", async () => {
    const { b } = simulated();
    const all = await pass(b);
    // category1 is named Bug; category2 has no text (Red); category3 is Frontend.
    expect(all.items[0].labels).toEqual(["Bug", "Red"]);
    expect(all.items[1].labels).toEqual(["Frontend"]);
    expect(all.items[2].labels).toEqual([]);
  });

  it("priority 0-10 falls in four classes", async () => {
    const { b } = simulated();
    const all = await pass(b);
    expect(all.items.map((i) => i.priority?.name)).toEqual(["Urgent", "Important", "Low"]);
    expect(all.items[0].priority?.rank).toBeLessThan(all.items[2].priority?.rank ?? 0);
  });

  it("percentComplete is a status: 0 not started, 1-99 in progress, 100 completed", async () => {
    const { b, sim } = simulated();
    const t = sim.add("Halfway");
    sim.outside.setPercent(t, 70);
    expect((await b.getIssue(meta(), ref(t)))?.status).toMatchObject({ name: "In progress", category: "doing", source: { kind: "itemState" } });
    sim.outside.setPercent(t, 100);
    const done = await b.getIssue(meta(), ref(t));
    expect(done?.status).toMatchObject({ name: "Completed", category: "done" });
    expect(done?.statusChangedAt).not.toBeNull();
    sim.outside.setPercent(t, 0);
    expect((await b.getIssue(meta(), ref(t)))?.status).toMatchObject({ name: "Not started" });
    expect((await b.getIssue(meta(), ref(t)))?.statusChangedAt).toBeNull();
  });

  it("a due date picked in the apps is midnight UTC and stays that day; any other instant falls on the user's day", async () => {
    const { sim, b } = simulated();
    expect((await b.getIssue(meta(), ref(sim.tasks[0])))?.due).toBe("2026-11-05");
    const late = sim.add("Late", { due: "2026-11-05T23:30:00Z" });
    expect((await b.getIssue(meta(), ref(late)))?.due).toBe("2026-11-06");
    const la = simulated({ zone: "America/Los_Angeles" });
    const a = la.sim.add("Early", { due: "2026-11-05T03:30:00Z" });
    expect((await la.b.getIssue(meta(), ref(a)))?.due).toBe("2026-11-04");
    // Midnight UTC would be the evening before in Los Angeles: not read as an instant.
    const picked = la.sim.add("Picked", { due: "2026-11-05T00:00:00Z" });
    expect((await la.b.getIssue(meta(), ref(picked)))?.due).toBe("2026-11-05");
    expect((await b.getIssue(meta(), ref(sim.tasks[1])))?.due).toBeNull();
  });

  it("a name needs User.ReadBasic.All: without it the id stands in", async () => {
    const { b, sim } = simulated();
    sim.state.hideUsers = true;
    const i = await b.getIssue(meta(), ref(sim.tasks[0]));
    expect(i?.assignees).toMatchObject([{ remoteId: sim.me.id, name: sim.me.id }]);
  });

  it("asks for each plan and each person once per read, not once per task", async () => {
    const { b, sim } = simulated();
    sim.log.length = 0;
    await pass(b);
    expect(sim.log.filter((l) => l === `GET /planner/plans/${sim.tasks[0].planId}`)).toHaveLength(1);
    expect(sim.log.filter((l) => l === `GET /users/${sim.me.id}`)).toHaveLength(1);
  });

  it("the description is in the details, not the task: plain text, line ends normalized, none read as null", async () => {
    const { b, sim } = simulated();
    expect(await b.description!(meta(), ref(sim.tasks[0]))).toEqual({ kind: "text", format: "plain", text: "Steps\nto reproduce" });
    expect(await b.description!(meta(), ref(sim.tasks[1]))).toBeNull();
    expect(await b.description!(meta(), { remoteId: "short", key: "PLANNER-short" })).toBeNull();
  });
});

describe("planner, passes", () => {
  it("has no change filter: a pass reads everything and tells what changed by the ETag, so only changes come after a checkpoint", async () => {
    const { b, sim } = simulated();
    const all = await pass(b);
    expect(all.checkpoint).not.toBeNull();
    expect((await pass(b, all.checkpoint)).items).toEqual([]);
    sim.outside.retitle(sim.tasks[0], "Login fails on Safari 18");
    sim.outside.moveToBucket(sim.tasks[2], "Done");
    const again = await pass(b, all.checkpoint);
    expect(again.items.map((i) => i.title)).toEqual(["Login fails on Safari 18", "Rate limit headers"]);
    // The next one starts from this one.
    expect((await pass(b, again.checkpoint)).items).toEqual([]);
  });

  it("the details have their own ETag: a new description does not move the task, so a pass does not see it (description reads it fresh)", async () => {
    const { b, sim } = simulated();
    const all = await pass(b);
    sim.outside.describe(sim.tasks[1], "Now with words");
    expect((await pass(b, all.checkpoint)).items).toEqual([]);
    expect((await b.description!(meta(), ref(sim.tasks[1])))?.kind).toBe("text");
  });

  it("reads a long list page by page by @odata.nextLink, no task twice, then only what changed", async () => {
    const { b, sim } = simulated();
    for (let n = 0; n < 230; n++) sim.add(`Bulk ${n}`);
    const all = await pass(b);
    expect(all.pages).toBe(3);
    expect(all.items.length).toBe(233);
    expect(new Set(all.items.map((i) => i.remoteId)).size).toBe(233);
    expect((await pass(b, all.checkpoint)).items).toEqual([]);
    sim.outside.retitle(sim.tasks[150], "Changed");
    expect((await pass(b, all.checkpoint)).items.map((i) => i.title)).toEqual(["Changed"]);
  });

  it("a skip token that has expired is an invalid checkpoint, so the pass is read again", async () => {
    const { b, sim } = simulated({ pageSize: 2 });
    const first = await b.listChanged(meta(), { since: null, page: null });
    expect(first.last).toBe(false);
    sim.expirePaging();
    if (!first.last) expect(await errorOf(b.listChanged(meta(), { since: null, page: first.next }))).toMatchObject({ kind: "invalidCheckpoint" });
    expect((await pass(b)).items.length).toBe(3);
  });

  it("never follows a next link to another host, the token would go with it", async () => {
    const { b, sim } = simulated({ pageSize: 2 });
    sim.state.nextLinkOrigin = "https://evil.example";
    const read = async () => {
      const first = await b.listChanged(meta(), { since: null, page: null });
      if (!first.last) await b.listChanged(meta(), { since: null, page: first.next });
    };
    expect(await errorOf(read())).toMatchObject({ kind: "incompatible" });
  });

  it("a first read takes the tasks completed lately and the open ones, not years of completed ones", async () => {
    const { b, sim } = simulated();
    const old = sim.add("Done long ago", { percent: 100 });
    old.completedAt = Date.now() - 90 * 86_400_000;
    sim.add("Done this week", { percent: 100 });
    const titles = (await pass(b)).items.map((i) => i.title);
    expect(titles).toContain("Done this week");
    expect(titles).not.toContain("Done long ago");
  });

  it("a deleted task is reported gone (404); unassigned, or in a plan the user left, are not reported", async () => {
    const { b, sim, web } = simulated();
    const lost = sim.plan("Secret", { buckets: ["Inbox"] });
    const there = sim.add("In a plan I will leave", { plan: lost });
    const all = await pass(b);
    expect(all.items.map((i) => i.title)).toContain("In a plan I will leave");
    sim.outside.delete(sim.tasks[0]);
    sim.outside.unassign(sim.tasks[1], sim.me.id);
    sim.outside.access(lost, false);
    const again = await pass(b, all.checkpoint);
    expect(again.items).toEqual([]);
    expect(again.gone).toEqual([{ remoteId: sim.tasks[0].id, reason: "deleted" }]);
    expect(web.access).toBe(true);
    // What is not there for the user is not an error on a lookup.
    expect(await b.getIssue(meta(), ref(there))).toBeNull();
    expect((await b.findIssue(meta(), { key: sim.keyOf(there) })).kind).toBe("none");
    expect(await b.getIssue(meta(), ref(sim.tasks[0]))).toBeNull();
    // A task reassigned to me comes back as new.
    sim.outside.assign(sim.tasks[1], sim.me.id);
    expect((await pass(b, again.checkpoint)).items.map((i) => i.title)).toEqual(["Export to CSV"]);
  });

  it("finds a task by key, by id and by every link shape; none for a key that is not one", async () => {
    const { b, sim } = simulated();
    const t = sim.tasks[0];
    expect(b.parseRef(sim.keyOf(t))).toEqual({ key: sim.keyOf(t) });
    expect(b.parseRef(`planner-${t.id}`)).toEqual({ key: sim.keyOf(t) });
    for (const url of [urlOf(t), `${urlOf(t)}?tid=0b2d`, `https://tasks.office.com/acme.onmicrosoft.com/en-US/Home/Task/${t.id}`, `https://tasks.microsoft.com/webui/plan/${t.planId}/view/board/task/${t.id}/`]) {
      expect(b.parseRef(url), url).toEqual({ key: sim.keyOf(t), remoteId: t.id });
    }
    expect(b.parseRef(`https://planner.cloud.microsoft/webui/plan/${t.planId}/view/board`)).toBeNull();
    expect(b.parseRef(`https://example.com/webui/task/${t.id}`)).toBeNull();
    const found = await b.findIssue(meta(), { remoteId: t.id });
    expect(found).toMatchObject({ kind: "found", issue: { title: "Login fails on Safari" } });
    expect((await b.findIssue(meta(), { key: "PLANNER-notanidatall" })).kind).toBe("none");
  });

  it("reads the options: bucket names to categories, case and spaces aside; nothing else", async () => {
    const { b } = simulated(COLUMNS);
    expect(plannerProvider.parseOptions({ columns: { " Doing ": "doing" } })).toEqual({ columns: { doing: "doing" } });
    expect(plannerProvider.parseOptions(undefined)).toEqual({ columns: {} });
    expect(() => plannerProvider.parseOptions({ columns: { Doing: "started" } })).toThrow();
    expect(() => plannerProvider.parseOptions({ plan: "x" })).toThrow();
    expect((await pass(b)).items.length).toBe(3);
  });
});

describe("planner, buckets and transitions", () => {
  it("a bucket means nothing until the options say what: unmapped, the status is the percentComplete", async () => {
    const { b } = simulated({ options: { columns: { Doing: "doing" } } });
    const all = await pass(b);
    expect(all.items.map((i) => [i.title, i.status.name, i.status.source.kind])).toEqual([
      ["Login fails on Safari", "Not started", "itemState"],
      ["Export to CSV", "Doing", "column"],
      ["Rate limit headers", "Not started", "itemState"],
    ]);
  });

  it("a mapped bucket is the status of an open task, with its category from the mapping; completed beats the bucket", async () => {
    const { b, sim } = simulated(COLUMNS);
    const all = await pass(b);
    expect(all.items.map((i) => [i.status.name, i.status.category, i.status.source.kind])).toEqual([
      ["To do", "todo", "column"],
      ["Doing", "doing", "column"],
      ["Review", "doing", "column"],
    ]);
    expect(all.items[1].status.categoryOrigin.by).toBe("mapping");
    sim.outside.setPercent(sim.tasks[1], 100);
    expect((await b.getIssue(meta(), ref(sim.tasks[1])))?.status).toMatchObject({ name: "Completed", category: "done", source: { kind: "itemState" } });
  });

  it("a bucket is matched by its name, so a rename outside changes the mapping", async () => {
    const { b, sim, web } = simulated(COLUMNS);
    sim.outside.renameBucket(web, "Doing", "In flight");
    expect((await b.getIssue(meta(), ref(sim.tasks[1])))?.status).toMatchObject({ name: "In progress", source: { kind: "itemState" } });
    sim.outside.renameBucket(web, "In flight", "DOING");
    expect((await b.getIssue(meta(), ref(sim.tasks[1])))?.status).toMatchObject({ name: "DOING", category: "doing" });
  });

  it("lists the statuses of a source: the three progress states, or the mapped buckets of a plan in order", async () => {
    const { b, web } = simulated(COLUMNS);
    const probe = await b.probe(meta());
    const progress = probe.activeSources.find((s) => s.kind === "itemState");
    const board = probe.activeSources.find((s) => s.kind === "column" && s.ref.boardRemoteId === web.id);
    if (!progress || !board) throw new Error("sources missing");
    expect((await b.statuses!(meta(), progress)).map((s) => [s.name, s.category])).toEqual([
      ["Not started", "todo"],
      ["In progress", "doing"],
      ["Completed", "done"],
    ]);
    expect((await b.statuses!(meta(), board)).map((s) => [s.name, s.category, s.order])).toEqual([
      ["To do", "todo", 0],
      ["Doing", "doing", 1],
      ["Review", "doing", 2],
      ["Done", "done", 3],
      ["Won't do", "cancelled", 4],
    ]);
  });

  it("the probe gives the progress source, and a board per plan once the options name buckets", async () => {
    const plain = simulated();
    expect((await plain.b.probe(meta())).activeSources.map((s) => s.kind)).toEqual(["itemState"]);
    const mapped = simulated(COLUMNS);
    mapped.sim.plan("Hidden", { buckets: ["X"], access: false });
    const probe = await mapped.b.probe(meta());
    expect(probe.activeSources.map((s) => s.kind)).toEqual(["itemState", "column"]);
    expect(probe.activeSources[1]).toMatchObject({ name: "Website" });
    expect(probe.rateLimit).toBeUndefined();
  });

  it("offers the ways out of a status: moves to the other mapped buckets, start, complete; a completed task can be reopened", async () => {
    const { b, sim } = simulated(COLUMNS);
    const ways = await b.transitions!.list!(meta(), ref(sim.tasks[0]));
    expect(ways.map((w) => [w.id.startsWith("bucket:") ? "bucket" : w.id, w.name, w.to.category])).toEqual([
      ["bucket", "Move to Doing", "doing"],
      ["bucket", "Move to Review", "doing"],
      ["bucket", "Move to Done", "done"],
      ["bucket", "Move to Won't do", "cancelled"],
      ["percent:100", "Complete", "done"],
    ]);
    expect(ways.every((w) => w.remoteUrl === urlOf(sim.tasks[0]))).toBe(true);
    sim.outside.setPercent(sim.tasks[0], 100);
    expect((await b.transitions!.list!(meta(), ref(sim.tasks[0]))).map((w) => [w.id, w.to.name])).toEqual([["percent:0", "To do"]]);

    const plain = simulated();
    expect((await plain.b.transitions!.list!(meta(), ref(plain.sim.tasks[0]))).map((w) => w.id)).toEqual(["percent:50", "percent:100"]);
    expect((await plain.b.transitions!.list!(meta(), ref(plain.sim.tasks[1]))).map((w) => w.id)).toEqual(["percent:100"]);
  });

  it("moves a task to a bucket, completes it and reopens it; the answer is the task as it is after", async () => {
    const { b, sim } = simulated(COLUMNS);
    const t = sim.tasks[0];
    const moved = (await b.transitions!.list!(meta(), ref(t))).find((w) => w.name === "Move to Review")!;
    expect(await b.transitions!.apply!(meta(), ref(t), moved.id, {})).toMatchObject({ status: { name: "Review", category: "doing" } });
    expect(t.bucketId).toBe(sim.bucket(sim.plans.get(t.planId)!, "Review"));
    expect(await b.transitions!.apply!(meta(), ref(t), "percent:100", {})).toMatchObject({ status: { name: "Completed", category: "done" } });
    expect(t.completedAt).not.toBeNull();
    // Reopening goes back to the bucket the task was left in.
    expect(await b.transitions!.apply!(meta(), ref(t), "percent:0", {})).toMatchObject({ status: { name: "Review" } });
    expect(t.completedAt).toBeNull();
    const plain = simulated();
    expect(await plain.b.transitions!.apply!(meta(), ref(plain.sim.tasks[0]), "percent:50", {})).toMatchObject({ status: { name: "In progress", category: "doing" } });
  });

  it("refuses a transition that is not one of the task's: another percent, an unmapped bucket, a bucket of nowhere", async () => {
    const { b, sim, web } = simulated({ options: { columns: { Doing: "doing" } } });
    const t = sim.tasks[0];
    for (const id of ["percent:70", "bucket:nowhere", `bucket:${sim.bucket(web, "Done")}`, "complete"]) {
      expect(await errorOf(b.transitions!.apply!(meta(), ref(t), id, {})), id).toMatchObject({ kind: "invalid" });
    }
    expect(t.percent).toBe(0);
  });

  it("a change needs the ETag it was read at: If-Match (428 without, 412 when stale), and answers 204 unless asked for the representation", async () => {
    const { sim } = simulated();
    const t = sim.tasks[0];
    const path = `/planner/tasks/${t.id}`;
    expect((await raw(sim, path, { method: "PATCH", body: { percentComplete: 50 } })).status).toBe(428);
    expect((await raw(sim, path, { method: "PATCH", headers: { "If-Match": 'W/"stale"' }, body: { percentComplete: 50 } })).status).toBe(412);
    const quiet = await raw(sim, path, { method: "PATCH", headers: { "If-Match": sim.etagOf(t) }, body: { percentComplete: 50 } });
    expect(quiet.status).toBe(204);
    expect(await quiet.text()).toBe("");
    const loud = await raw(sim, path, { method: "PATCH", headers: { "If-Match": sim.etagOf(t), Prefer: "return=representation" }, body: { percentComplete: 100 } });
    expect(loud.status).toBe(200);
    expect(await loud.json()).toMatchObject({ id: t.id, percentComplete: 100 });
    expect((await raw(sim, path, { method: "PATCH", headers: { "If-Match": sim.etagOf(t), Prefer: "return=representation" }, body: { percentComplete: 150 } })).status).toBe(400);
  });

  it("someone changing the task between the read and the change (412) is read again once", async () => {
    const { b, sim } = simulated();
    sim.state.raceNext = true;
    sim.log.length = 0;
    expect(await b.transitions!.apply!(meta(), ref(sim.tasks[0]), "percent:100", {})).toMatchObject({ status: { name: "Completed" } });
    expect(sim.log.filter((l) => l.startsWith("PATCH"))).toHaveLength(2);
  });

  it("a server that does not give the representation back (204) still yields the task as it is after", async () => {
    const { b, sim } = simulated();
    sim.state.noRepresentation = 1;
    expect(await b.transitions!.apply!(meta(), ref(sim.tasks[0]), "percent:100", {})).toMatchObject({ status: { name: "Completed" } });
  });

  it("sends the change with If-Match and the ETag of a fresh read, once when nothing intervenes", async () => {
    const { b, sim } = simulated();
    sim.log.length = 0;
    await b.transitions!.apply!(meta(), ref(sim.tasks[0]), "percent:100", {});
    expect(sim.log.filter((l) => l.startsWith("PATCH"))).toEqual([`PATCH /planner/tasks/${sim.tasks[0].id}`]);
  });
});

describe("planner, errors and limits", () => {
  it("a bad token is auth (401)", async () => {
    const { b } = simulated({ token: "wrong" });
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "auth" });
  });

  it("an access token lives about an hour: an expired one is auth, and says so", async () => {
    const { b, sim } = simulated();
    expect((await b.verify(meta())).remoteId).toBe(sim.me.id);
    sim.state.expired = true;
    expect(await errorOf(pass(b))).toMatchObject({ kind: "auth", message: expect.stringContaining("expired") });
  });

  it("a revoked token is auth on every call", async () => {
    const { b, sim } = simulated();
    sim.state.revoked = true;
    expect(await errorOf(pass(b))).toMatchObject({ kind: "auth" });
  });

  it("throttling is a wait: 429 with Retry-After in seconds", async () => {
    const { b, sim } = simulated();
    sim.state.exhausted = true;
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 30_000, remaining: 0 } });
    sim.state.exhausted = false;
    expect((await b.verify(meta())).name).toBe("Mario Rossi");
  });

  it("a 503 with Retry-After is a wait too; one without is the service being down", async () => {
    const { b } = simulated();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "serviceNotAvailable", message: "busy" } }), { status: 503, headers: { "Retry-After": "7" } }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "rateLimit", rateLimit: { retryAfterMs: 7000 } });
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    expect(await errorOf(b.verify(meta()))).toMatchObject({ kind: "unavailable" });
  });

  it("a missing task is notFound where an operation needs it, null where a lookup asks", async () => {
    const { b } = simulated();
    const ghost = { remoteId: "XxXxXxXx_xXxXxXxXxXxXxXxXx99", key: "PLANNER-XxXxXxXx_xXxXxXxXxXxXxXxXx99" };
    expect(await b.getIssue(meta(), ghost)).toBeNull();
    expect(await errorOf(b.transitions!.list!(meta(), ghost))).toMatchObject({ kind: "notFound" });
    expect(await errorOf(b.transitions!.apply!(meta(), ghost, "percent:100", {}))).toMatchObject({ kind: "notFound" });
  });

  it("a plan the user cannot read still gives its tasks, named by id", async () => {
    const { b, sim } = simulated();
    const t = sim.add("Orphan");
    // The plan answers 403 for its details while the task itself is readable: the container falls back to the id.
    const plan = sim.plans.get(t.planId)!;
    const real = sim.fetch;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => (String(input).endsWith(`/planner/plans/${plan.id}`) ? new Response(JSON.stringify({ error: { code: "Forbidden", message: "no" } }), { status: 403 }) : real(input, init)));
    expect(await b.getIssue(meta(), ref(t))).toMatchObject({ container: { remoteId: plan.id, name: plan.id }, status: { name: "Not started" } });
  });

  it("knows who the token belongs to; Graph gives no budget figure", async () => {
    const { b, sim } = simulated();
    expect(await b.verify(meta())).toMatchObject({ remoteId: sim.me.id, name: "Mario Rossi", email: "mario@acme.example", login: "mario@acme.onmicrosoft.com" });
  });
});
