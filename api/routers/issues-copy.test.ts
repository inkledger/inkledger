// Copying an issue for an agent (docs/work/ideas/issue-copy.md R-6.1, R-6.4, R-6.10): ownership, the duration, the comments.
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
  if (url.includes("?fields=attachment"))
    return json({ fields: { attachment: url.includes("/PRJ-7?") ? [{ id: "10001", filename: "shot.png", mimeType: "image/png", size: 4 }] : [] } });
  if (url.includes("/issue/PRJ-7/comment?")) {
    // Two pages: every comment is copied, not only the newest page.
    const startAt = Number(new URL(url).searchParams.get("startAt"));
    const adf = (content: unknown[]) => ({ type: "doc", version: 1, content });
    const all = [
      { id: "3", author: { displayName: "Luca" }, created: "2026-11-05T10:00:00.000+0000", body: adf([{ type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "m1", alt: "shot.png" } }] }]) },
      { id: "2", author: { displayName: "Anna" }, created: "2026-11-04T10:00:00.000+0000", body: adf([{ type: "paragraph", content: [{ type: "text", text: "Second" }] }]) },
      { id: "1", author: { displayName: "Anna" }, created: "2026-11-03T10:00:00.000+0000", body: adf([{ type: "paragraph", content: [{ type: "text", text: "First" }] }]) },
    ];
    return json({ startAt, total: all.length, comments: startAt === 0 ? all.slice(0, 2) : all.slice(startAt) });
  }
  if (url.includes("/issue/PRJ-8/comment?")) return new Response("{}", { status: 503 });
  if (url.includes("/comment?")) return json({ comments: [], total: 0 });
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

  it("comments come oldest first, their images through signed links", async () => {
    const u = await signedIn("d@x.it");
    await issueOf(u.user.id, "PRJ-7");
    const { markdown } = await u.caller.issues.copyForAgent({ key: "PRJ-7" });
    const first = markdown.indexOf("First");
    expect(first).toBeGreaterThan(markdown.indexOf("## Comments"));
    expect(markdown.indexOf("Second")).toBeGreaterThan(first);
    expect(markdown).toMatch(/### Luca · \d{4}-\d{2}-\d{2} \d{2}:\d{2}\n\n!\[shot\.png\]\(http:\/\/localhost\/api\/shared\/[\w.-]+\)/);
    expect(markdown.indexOf("## Attachments")).toBeGreaterThan(markdown.indexOf("### Luca"));
  });

  it("comments the tracker can't give now don't stop the copy", async () => {
    const u = await signedIn("e@x.it");
    await issueOf(u.user.id, "PRJ-8");
    const { markdown } = await u.caller.issues.copyForAgent({ key: "PRJ-8" });
    expect(markdown).toContain("# PRJ-8: Mine");
    expect(markdown).toContain("## Comments\n\n(comments unavailable)");
  });
});
