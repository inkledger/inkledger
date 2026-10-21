import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "140.82.112.6", family: 4 }]),
}));

import { githubSimulator } from "../providers/github/simulator";

const sim = githubSimulator();
sim.add("acme/web", "Login fails on Safari", { body: "Steps to reproduce" });
sim.add("acme/web", "Export to CSV");
sim.repo("acme/empty");
/** A second GitHub account (work), reached with its own token. */
const work = githubSimulator(undefined, { id: 777, login: "mrossi-work", name: "Mario at Work" });
work.add("bigco/app", "Billing export");

/** GitHub's device login: pending twice (one slow_down), then the token. */
/** Calls that reached GitHub's API (not its login). */
let apiCalls = 0;
/** GitHub not answering. */
let githubDown = false;
const answers: Record<string, unknown>[] = [{ error: "authorization_pending" }, { error: "slow_down", interval: 6 }, { access_token: "gho_test", token_type: "bearer" }];
vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });
  if (url === "https://github.com/login/device/code") {
    return json({ device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
  }
  if (url === "https://github.com/login/oauth/access_token") return json(answers.shift() ?? { error: "expired_token" });
  apiCalls++;
  if (githubDown) return new Response(JSON.stringify({ message: "down" }), { status: 503 });
  const auth = new Headers(init?.headers).get("Authorization");
  return (auth === "Bearer gho_work" ? work : sim).fetch(input, init);
});

describe("Settings → Connections: GitHub by its own login", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let caller: Caller;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const [user] = await getDb().insert(users).values({ username: "mario", displayName: "Mario" }).returning();
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  });

  it("is offered on every server: inkledger's own OAuth App, nothing to set up", async () => {
    expect((await caller.connections.catalog()).find((c) => c.type === "github")).toMatchObject({ status: "built", how: "oauthDevice" });
  });

  it("signs in with a code entered on GitHub, waiting as GitHub asks, and makes the connection", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const flow = await caller.connections.githubStart({ label: "Side projects" });
      expect(flow).toMatchObject({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
      const at = Date.now();
      expect(await caller.connections.githubPoll({ flowId: flow.flowId })).toEqual({ state: "pending", retryInSeconds: 5 });
      // Asked again too soon: GitHub isn't called (its answers stay queued).
      vi.setSystemTime(at + 1_000);
      expect(await caller.connections.githubPoll({ flowId: flow.flowId })).toEqual({ state: "pending", retryInSeconds: 4 });
      expect(answers).toHaveLength(2);
      vi.setSystemTime(at + 5_000);
      // slow_down: GitHub's new interval from now on.
      expect(await caller.connections.githubPoll({ flowId: flow.flowId })).toEqual({ state: "pending", retryInSeconds: 6 });
      vi.setSystemTime(at + 11_000);
      const done = await caller.connections.githubPoll({ flowId: flow.flowId });
      expect(done).toMatchObject({ state: "done", connection: { type: "github", name: "GitHub", host: "api.github.com", label: "Side projects", displayName: "Mario Rossi" } });
      // Done: the flow is gone.
      expect(await caller.connections.githubPoll({ flowId: flow.flowId })).toEqual({ state: "failed", reason: "expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("its issues sync through the contract, and the issue page and its moves go to GitHub", async () => {
    const [conn] = await caller.connections.list();
    const tested = await caller.connections.test({ id: conn.id });
    expect(tested.signedInAs).toBe("Mario Rossi");

    await caller.issues.sync();
    const all = await caller.issues.all({ scope: "all" });
    expect(all.map((i) => i.key).sort()).toEqual(["acme/web#1", "acme/web#2"]);

    expect(await caller.issues.description({ key: "acme/web#1" })).toMatchObject({ text: "Steps to reproduce", doc: { blocks: [{ t: "p" }] } });
    await caller.issues.addComment({ key: "acme/web#1", text: "On it" });
    expect((await caller.issues.comments({ key: "acme/web#1" })).map((c) => [c.body, c.isMine])).toEqual([["On it", true]]);

    const ways = await caller.issues.transitions({ key: "acme/web#1" });
    expect(ways.map((w) => [w.name, w.toCategory, w.executable])).toEqual([
      ["Close as completed", "done", true],
      ["Close as not planned", "cancelled", true],
    ]);
    expect(await caller.issues.transition({ key: "acme/web#1", transitionId: "not_planned" })).toEqual({ moved: "acme/web#1", to: "Not planned" });
    expect(await caller.issues.get({ key: "acme/web#1" })).toMatchObject({ key: "acme/web#1", status: "Not planned" });
  });

  const signIn = async (token: string, label: string) => {
    answers.push({ access_token: token });
    const flow = await caller.connections.githubStart({ label });
    return caller.connections.githubPoll({ flowId: flow.flowId });
  };

  it("connects as many GitHub accounts as the user has; the same account again is the same connection", async () => {
    const second = await signIn("gho_work", "Work");
    expect(second).toMatchObject({ state: "done", connection: { type: "github", label: "Work", displayName: "Mario at Work" } });
    expect((await caller.connections.list()).filter((c) => c.type === "github")).toHaveLength(2);

    await caller.issues.sync();
    expect((await caller.issues.all({ scope: "all" })).map((i) => i.key).sort()).toEqual(["acme/web#1", "acme/web#2", "bigco/app#1"]);
    // Each issue answers on its own account.
    expect((await caller.issues.transitions({ key: "bigco/app#1" })).map((w) => w.name)).toContain("Close as completed");

    const again = await signIn("gho_test", "");
    const [first] = await caller.connections.list();
    expect(again).toMatchObject({ state: "done", connection: { id: first.id, label: "Side projects" } });
    expect((await caller.connections.list()).filter((c) => c.type === "github")).toHaveLength(2);
  });

  it("lists every repository it follows, empty ones too; one left out leaves the lists at once and comes back when brought back", async () => {
    const conn = (await caller.connections.list()).find((c) => c.label === "Side projects")!;
    expect(conn.excludable).toBe(true);
    expect((await caller.connections.containers({ id: conn.id })).map((c) => [c.key, c.excluded])).toEqual([
      ["acme/empty", false],
      ["acme/web", false],
    ]);
    const keys = async () => (await caller.issues.all({ scope: "all" })).map((i) => i.key).filter((k) => k.startsWith("acme/web")).sort();
    expect(await keys()).toEqual(["acme/web#1", "acme/web#2"]);

    await caller.connections.setExcluded({ id: conn.id, keys: ["acme/web"] });
    expect(await keys()).toEqual([]);
    await caller.issues.sync();
    expect(await keys()).toEqual([]);
    expect((await caller.connections.containers({ id: conn.id })).find((c) => c.key === "acme/web")?.excluded).toBe(true);

    await caller.connections.setExcluded({ id: conn.id, keys: [] });
    await caller.issues.sync();
    expect(await keys()).toEqual(["acme/web#1", "acme/web#2"]);
  });

  it("a connection GitHub stopped accepting, signed in again, works again and keeps its options", async () => {
    const conn = (await caller.connections.list()).find((c) => c.label === "Side projects")!;
    await caller.connections.setExcluded({ id: conn.id, keys: ["acme/empty"] });
    const { q } = await import("../queries/connection");
    await q("UPDATE connections SET status = 'auth_failed' WHERE id = ?", conn.id);
    const again = await signIn("gho_test", "");
    expect(again).toMatchObject({ state: "done", connection: { id: conn.id, status: "ok" } });
    expect((await caller.connections.containers({ id: conn.id })).find((c) => c.key === "acme/empty")?.excluded).toBe(true);
    await caller.connections.setExcluded({ id: conn.id, keys: [] });
  });

  it("manages issues from the app: assignees, labels, title and body, new issues in a repository", async () => {
    const key = "acme/web#2";
    expect(await caller.issues.manageable({ key })).toEqual({ assign: true, labels: true, create: true, edit: true, types: false });

    const people = await caller.issues.assignable({ key });
    expect(people.map((p) => [p.handle, p.isMe])).toEqual([
      ["mrossi", true],
      ["anna-b", false],
    ]);
    await caller.issues.assign({ key, people: people.filter((p) => !p.isMe) });
    expect((await caller.issues.get({ key })).assigneeName).toBe("Anna Bianchi");
    await caller.issues.assign({ key, people });

    expect(await caller.issues.labelOptions({ key })).toEqual(["bug", "enhancement", "ui"]);
    expect((await caller.issues.setLabels({ key, labels: ["bug", "ui"] })).labels).toEqual(["bug", "ui"]);

    await caller.issues.edit({ key, title: "Export to CSV and Excel", body: "Both **formats**" });
    expect((await caller.issues.get({ key })).summary).toBe("Export to CSV and Excel");
    expect(await caller.issues.description({ key })).toMatchObject({ text: "Both **formats**", doc: { blocks: [{ t: "p", c: [{ t: "text", v: "Both " }, { t: "strong", c: [{ t: "text", v: "formats" }] }] }] } });

    const conn = (await caller.connections.list()).find((c) => c.label === "Side projects")!;
    const made = await caller.issues.createIn({ connectionId: conn.id, container: "acme/empty", title: "First issue", body: "Hello", labels: ["enhancement"], assignToMe: true });
    expect(made.key).toBe("acme/empty#1");
    expect(await caller.issues.get({ key: made.key })).toMatchObject({ summary: "First issue", projectKey: "acme/empty", assigneeName: "Mario Rossi" });
  });

  it("keeps time on GitHub issues in inkledger: logged, changed, deleted, never sent to GitHub", async () => {
    const key = "acme/web#2";
    const calls = apiCalls;
    const started = "2026-10-19T09:00:00+02:00";
    const made = await caller.worklogs.create({ issueKey: key, seconds: 5400, started, comment: "Pairing" });
    expect(made).toMatchObject({ issueKey: key, timeSpentSeconds: 5400, comment: "Pairing" });
    expect(made.remoteId).toMatch(/^local-/);
    expect((await caller.worklogs.list({ issueKey: key })).map((w) => w.timeSpentSeconds)).toEqual([5400]);

    const moved = await caller.worklogs.update({ id: made.id, seconds: 3600, started, comment: "Pairing, shorter" });
    expect(moved).toMatchObject({ id: made.id, timeSpentSeconds: 3600, comment: "Pairing, shorter" });
    expect(await caller.worklogs.syncIssue({ issueKey: key })).toEqual({ synced: 0 });

    await caller.worklogs.delete({ id: made.id });
    expect(await caller.worklogs.list({ issueKey: key })).toEqual([]);
    expect((await caller.worklogs.trash()).map((w) => [w.issueKey, w.timeSpentSeconds])).toContainEqual([key, 3600]);
    // GitHub keeps no time: nothing was asked of it.
    expect(apiCalls).toBe(calls);
  });

  it("searches every tracker: a key finds its issue, words go to GitHub's search; import goes through the contract", async () => {
    const byKey = await caller.issues.search({ query: "acme/web#1" });
    expect(byKey.failed).toEqual([]);
    expect(byKey.results[0]).toMatchObject({ key: "acme/web#1", imported: true, canWatch: false });
    const byWords = await caller.issues.search({ query: "Billing" });
    expect(byWords.results.map((r) => r.key)).toContain("bigco/app#1");
    const work = byWords.results.find((r) => r.key === "bigco/app#1")!;
    expect(await caller.issues.import({ key: work.key, connectionId: work.connectionId })).toEqual({ imported: "bigco/app#1" });
  });

  it("what changes on GitHub between syncs goes to the issue's history and the user's news", async () => {
    const later = new Date(Date.UTC(2030, 0, 1)).toISOString();
    const issue = sim.issues.find((i) => i.repo === "web" && i.number === 1)!;
    Object.assign(issue, { title: "Login fails on Safari 18", updated_at: later });
    sim.add("acme/web", "A new one for me");
    sim.issues.at(-1)!.updated_at = later;
    await caller.issues.sync();
    const history = await caller.issues.history({ key: "acme/web#1" });
    expect(history.events.find((e) => e.kind === "change")).toMatchObject({ items: [{ from: "Login fails on Safari", to: "Login fails on Safari 18" }] });
    const news = await caller.notifications.list();
    expect(news.map((n) => [n.kind, n.issueKey])).toContainEqual(["assigned", "acme/web#3"]);
  });

  it("polls with ETags: a page that didn't change comes back 304 (free on GitHub) and reads as before", async () => {
    const before = sim.notModified();
    const keys = async () => (await caller.issues.all({ scope: "all" })).map((i) => i.key).sort();
    const was = await keys();
    await caller.issues.sync();
    expect(sim.notModified()).toBeGreaterThan(before);
    expect(await keys()).toEqual(was);
  });

  it("GitHub's inbox becomes news (what was there before isn't), and dismissing one reads it on GitHub too", async () => {
    sim.notify("acme/web", 1, "mention", "Old mention");
    await caller.issues.sync();
    const kinds = async () => (await caller.notifications.list()).filter((n) => n.kind === "mentioned" || n.kind === "review");
    expect(await kinds()).toEqual([]);
    sim.notify("acme/web", 2, "mention", "Can you look?");
    sim.notify("acme/web", 1, "review_requested", "Review please");
    await caller.issues.sync();
    const news = await kinds();
    expect(news.map((n) => [n.kind, n.issueKey]).sort()).toEqual([
      ["mentioned", "acme/web#2"],
      ["review", "acme/web#1"],
    ]);
    // Seen again: no second copy.
    await caller.issues.sync();
    expect(await kinds()).toHaveLength(2);
    await caller.notifications.dismiss({ id: news.find((n) => n.kind === "mentioned")!.id });
    expect(sim.threads.find((t) => t.subject.title === "Can you look?")?.unread).toBe(false);
  });

  it("shows what an issue has besides the mapped fields, the last copy when GitHub doesn't answer", async () => {
    const live = await caller.issues.otherFields({ key: "acme/web#1" });
    expect(live).toEqual({ fields: [{ name: "Author", value: "mrossi" }], stale: false });
    githubDown = true;
    try {
      expect(await caller.issues.otherFields({ key: "acme/web#1" })).toEqual({ fields: [{ name: "Author", value: "mrossi" }], stale: true });
    } finally {
      githubDown = false;
    }
  });

  it("what is mine is a choice of the connection: every issue of the repositories followed, or only the assigned", async () => {
    const conn = (await caller.connections.list()).find((c) => c.label === "Side projects")!;
    expect(conn.settings).toEqual([{ key: "mine", choices: ["followed", "assigned"], value: "followed" }]);
    await expect(caller.connections.setOption({ id: conn.id, key: "mine", value: "everything" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    sim.add("acme/web", "Someone else's", { assignee: null });
    await caller.issues.syncConnection({ id: conn.id, reconcile: true });
    const titles = async () => (await caller.issues.all({ scope: "all" })).filter((i) => i.connectionId === conn.id).map((i) => i.summary);
    expect(await titles()).toContain("Someone else's");
    const saved = await caller.connections.setOption({ id: conn.id, key: "mine", value: "assigned" });
    expect(saved.settings[0].value).toBe("assigned");
    // From now on only the assigned come in; what the catalogue has stays (its time, its notes).
    sim.add("acme/web", "Another one for someone else", { assignee: null });
    sim.add("acme/web", "Another one for me");
    await caller.issues.syncConnection({ id: conn.id, reconcile: true });
    expect(await titles()).toContain("Another one for me");
    expect(await titles()).not.toContain("Another one for someone else");
    expect(await titles()).toContain("Someone else's");
    await caller.connections.setOption({ id: conn.id, key: "mine", value: "followed" });
  });

  it("searches each tracker in its own words: operators become GitHub qualifiers, what it can't say is named", async () => {
    const conn = (await caller.connections.list()).find((c) => c.label === "Side projects")!;
    const issue = sim.issues.find((i) => i.repo === "web" && i.number === 2)!;
    issue.labels = [{ name: "bug" }];
    const found = await caller.issues.searchOn({ connectionId: conn.id, query: "label:bug project:acme/web" });
    expect(found.results.map((r) => r.key)).toEqual(["acme/web#2"]);
    expect(found.unsupported).toEqual([]);
    const partly = await caller.issues.searchOn({ connectionId: conn.id, query: "-label:bug project:acme/web priority>=high" });
    expect(partly.results.map((r) => r.key)).not.toContain("acme/web#2");
    expect(partly.unsupported).toEqual(["priority:>=high"]);
  });
});
