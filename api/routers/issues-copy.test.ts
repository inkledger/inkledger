// Copying an issue for an agent (docs/work/ideas/issue-copy.md R-6.1, R-6.4): ownership and the duration.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { jiraSignIn } from "../testing/signIn";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) }));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  // One Jira account per sign-in name (basic auth), so each is its own user here.
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  if (url.endsWith("/rest/api/3/myself")) return json({ accountId: `acc-${auth}`, displayName: "Mario" });
  if (url.includes("?fields=description")) return json({ fields: { description: null } });
  if (url.includes("?fields=attachment")) return json({ fields: { attachment: [] } });
  return new Response(JSON.stringify({ errorMessages: [`unmocked ${url}`] }), { status: 500 });
});

async function signedIn(username: string) {
  const resHeaders = new Headers();
  await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username, secret: "t" });
  const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
  const { userFromRequest } = await import("../context");
  const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
  const { appRouter } = await import("../router");
  return { user: ctx.user!, caller: appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId }) };
}

async function issueOf(userId: number, key: string) {
  const { q } = await import("../queries/connection");
  const [{ id }] = await q<{ id: number }>("SELECT id FROM connections WHERE user_id = ? ORDER BY id LIMIT 1", userId);
  await q(
    "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, ?, ?, 'Mine', 'To Do', 'PRJ', 'Project', ?, 1)",
    userId, id, `r-${key}-${userId}`, key, `${SITE}/browse/${key}`,
  );
  return id;
}

describe("issues.copyForAgent", () => {
  beforeAll(async () => {
    vi.stubGlobal("fetch", fetchMock);
    await (await import("../queries/connection")).resetDbForTests();
  });

  it("another user's issue can't be copied", async () => {
    const a = await signedIn("a@x.it");
    const b = await signedIn("b@x.it");
    expect(b.user.id).not.toBe(a.user.id);
    const connA = await issueOf(a.user.id, "PRJ-5");
    await expect(b.caller.issues.copyForAgent({ key: "PRJ-5", connectionId: connA })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await a.caller.issues.copyForAgent({ key: "PRJ-5", connectionId: connA })).markdown).toContain("# PRJ-5: Mine");
  });

  it("the duration is bounded and defaults to the setting", async () => {
    const u = await signedIn("c@x.it");
    await issueOf(u.user.id, "PRJ-6");
    await expect(u.caller.issues.copyForAgent({ key: "PRJ-6", minutes: 2000 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(u.caller.issues.copyForAgent({ key: "PRJ-6", minutes: 4 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const left = async (minutes?: number) => ((await u.caller.issues.copyForAgent({ key: "PRJ-6", minutes })).expiresAt.getTime() - Date.now()) / 60_000;
    // The setting's default is an hour.
    expect(await left()).toBeCloseTo(60, 0);
    await u.caller.settings.update({ shareLinkMinutes: 15 });
    expect(await left()).toBeCloseTo(15, 0);
    expect(await left(240)).toBeCloseTo(240, 0);
    await expect(u.caller.settings.update({ shareLinkMinutes: 1441 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // No description: said plainly.
    expect((await u.caller.issues.copyForAgent({ key: "PRJ-6" })).markdown).toContain("(no description)");
  });
});
