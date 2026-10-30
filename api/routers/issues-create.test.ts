import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const CLOUD = "https://acme.atlassian.net";
const SERVER = "https://jira.acme.it";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Bodies of POST /issue, by site. */
const posted: { site: string; body: { fields: Record<string, unknown> } }[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const site = url.origin;
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/myself")) {
      return site === SERVER
        ? json({ name: "mrossi", key: "JIRAUSER1", displayName: "Mario" })
        : json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    }
    // An Epic's create screen (Jira Server with Jira Software): Epic Name required, Jira's own fields too.
    if (url.pathname.endsWith("/issue/createmeta/NEW/issuetypes/10000")) {
      return json({
        isLast: true,
        values: [
          { fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } },
          { fieldId: "issuetype", name: "Issue Type", required: true, schema: { type: "issuetype", system: "issuetype" } },
          { fieldId: "project", name: "Project", required: true, schema: { type: "project", system: "project" } },
          { fieldId: "reporter", name: "Reporter", required: true, hasDefaultValue: true, schema: { type: "user", system: "reporter" } },
          { fieldId: "customfield_10102", name: "Epic Name", required: true, schema: { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-label" } },
          { fieldId: "priority", name: "Priority", required: true, hasDefaultValue: true, schema: { type: "priority", system: "priority" } },
          { fieldId: "components", name: "Components", required: false, schema: { type: "array", items: "component" }, allowedValues: [{ id: "1", name: "API" }] },
        ],
      });
    }
    if (url.pathname.endsWith("/issue/createmeta/NEW/issuetypes/10001")) {
      return json({ isLast: true, values: [{ fieldId: "summary", name: "Summary", required: true, schema: { type: "string", system: "summary" } }] });
    }
    if (url.pathname.endsWith("/issue/createmeta/NEW/issuetypes")) {
      return json({
        isLast: true,
        values: [
          { id: "10001", name: "Task" },
          { id: "10002", name: "Sub-task", subtask: true },
        ],
      });
    }
    if (url.pathname.endsWith("/project") || url.pathname.endsWith("/project/search")) {
      const list = [{ key: "NEW", name: "New project" }];
      return json(url.pathname.endsWith("/search") ? { values: list, isLast: true } : list);
    }
    if (/\/issue$/.test(url.pathname) && method === "POST") {
      posted.push({ site, body: JSON.parse(String(init?.body)) });
      return json({ id: "77", key: "NEW-77" }, 201);
    }
    const single = /\/issue\/(NEW-\d+)$/.exec(url.pathname);
    if (single) {
      return json({
        id: "77",
        key: single[1],
        fields: {
          summary: "Customer request",
          status: { name: "To Do", statusCategory: { key: "new" } },
          project: { key: "NEW", name: "New project" },
          assignee: site === SERVER ? { name: "mrossi", displayName: "Mario" } : { accountId: "acc-1", displayName: "Mario" },
          created: "2026-10-16T10:00:00.000+0200",
          updated: "2026-10-16T10:00:00.000+0200",
        },
      });
    }
    return json({ errorMessages: [`unmocked ${method} ${url.pathname}`] }, 500);
  }),
);

async function callerFor(site: string, deployment: "cloud" | "server") {
  const { appRouter } = await import("../router");
  const resHeaders = new Headers();
  await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: site, deployment, authType: "basic", username: "mrossi", secret: "t" });
  const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
  const { userFromRequest } = await import("../context");
  const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
  return appRouter.createCaller({
    req: new Request("http://localhost/"),
    resHeaders: new Headers(),
    user: ctx.user,
    sessionId: ctx.sessionId,
  });
}

describe("creating issues", () => {
  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
  });

  /** The user's one Jira connection (their sign-in made it). */
  const jiraOf = async (caller: Awaited<ReturnType<typeof callerFor>>) => (await caller.connections.list()).find((c) => c.type === "jira")!.id;

  it("offers each tracker's projects, with the types Jira asks for (no sub-tasks)", async () => {
    const caller = await callerFor(CLOUD, "cloud");
    const connectionId = await jiraOf(caller);
    const [jira] = await caller.issues.createTargets();
    expect(jira).toMatchObject({ connectionId, name: "Jira", types: true });
    expect(jira.containers).toContainEqual({ key: "NEW", name: "New project", mine: false });
    expect(await caller.issues.createTypes({ connectionId, container: "NEW" })).toEqual([{ id: "10001", name: "Task" }]);
  });

  it("Cloud: ADF description, assignee by accountId, issue imported and mine", async () => {
    const caller = await callerFor(CLOUD, "cloud");
    const connectionId = await jiraOf(caller);
    const r = await caller.issues.createIn({ connectionId, container: "NEW", type: "10001", title: "Customer request", body: "Line one\nLine two", assignToMe: true });
    expect(r).toMatchObject({ key: "NEW-77", connectionId, remoteId: "77" });
    const fields = posted.at(-1)!.body.fields;
    expect(fields.issuetype).toEqual({ id: "10001" });
    expect(fields.assignee).toEqual({ accountId: "acc-1" });
    expect(fields.description).toMatchObject({ type: "doc", version: 1 });
    const local = await caller.issues.get({ key: "NEW-77" });
    expect(local).toMatchObject({ remote: false, summary: "Customer request" });
    expect((await caller.issues.all()).find((i) => i.key === "NEW-77")?.isMine).toBe(true);
    // Mine now: it heads the list of projects.
    expect((await caller.issues.createTargets())[0].containers[0]).toMatchObject({ key: "NEW", mine: true });
  });

  it("Server: plain description, assignee by name; unassigned on request; a task when no type is given", async () => {
    const caller = await callerFor(SERVER, "server");
    const connectionId = await jiraOf(caller);
    await caller.issues.createIn({ connectionId, container: "NEW", type: "10001", title: "X", body: "text", assignToMe: true });
    expect(posted.at(-1)!.body.fields).toMatchObject({ assignee: { name: "mrossi" }, description: "text" });
    await caller.issues.createIn({ connectionId, container: "NEW", title: "Y", assignToMe: false });
    expect(posted.at(-1)!.body.fields.assignee).toBeUndefined();
    expect(posted.at(-1)!.body.fields.description).toBeUndefined();
    expect(posted.at(-1)!.body.fields.issuetype).toEqual({ id: "10001" });
    await expect(caller.issues.createIn({ connectionId, container: "NEW", title: "   " })).rejects.toThrow();
  });

  it("an Epic asks for its Epic Name, and Jira gets it", async () => {
    const caller = await callerFor(SERVER, "server");
    const connectionId = await jiraOf(caller);
    // Only what Jira requires and doesn't fill itself; the title starts it.
    expect(await caller.issues.createFields({ connectionId, container: "NEW", type: "10000" })).toEqual([
      { id: "customfield_10102", name: "Epic Name", required: true, type: "text", multiline: false, fillWith: "title" },
    ]);
    expect(await caller.issues.createFields({ connectionId, container: "NEW", type: "10001" })).toEqual([]);
    // Without it: refused here, Jira never asked (it would answer "Epic Name è obbligatorio").
    const before = posted.length;
    await expect(caller.issues.createIn({ connectionId, container: "NEW", type: "10000", title: "ChatBot recruiting" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.issues.createIn({ connectionId, container: "NEW", type: "10000", title: "ChatBot recruiting", fields: { customfield_10102: "x", nope: "y" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(posted.length).toBe(before);
    // With it: sent as Jira wants it, beside the title.
    await caller.issues.createIn({ connectionId, container: "NEW", type: "10000", title: "ChatBot recruiting", fields: { customfield_10102: "ChatBot" } });
    expect(posted.at(-1)!.body.fields).toMatchObject({ summary: "ChatBot recruiting", issuetype: { id: "10000" }, customfield_10102: "ChatBot" });
  });
});

