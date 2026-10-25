import { jiraSignIn } from "./testing/signIn";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));
vi.stubGlobal(
  "fetch",
  vi.fn(async () => new Response(JSON.stringify({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} }), { headers: { "Content-Type": "application/json" } })),
);

describe("answers compressed on their way", () => {
  let app: typeof import("./boot").default;
  let cookie = "";

  beforeAll(async () => {
    const { resetDbForTests, q } = await import("./queries/connection");
    await resetDbForTests();
    app = (await import("./boot")).default;
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: "https://acme.atlassian.net", deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const [u] = await q<{ id: number; c: number }>("SELECT u.id, c.id AS c FROM users u JOIN connections c ON c.user_id = u.id LIMIT 1");
    for (let i = 0; i < 200; i++) {
      await q(
        "INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, ?, ?, ?, 'To Do', 'PRJ', 'Project', 'u', 1)",
        u.id, u.c, `j-${i}`, `PRJ-${i}`, `An issue with a long enough summary to make the answer big ${i}`,
      );
    }
  });

  it("a large API answer goes gzipped to a client that takes it", async () => {
    const res = await app.request("/api/trpc/issues.all", { headers: { cookie, "accept-encoding": "gzip" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  it("the event stream is never compressed (it would be held back until a buffer fills)", async () => {
    const res = await app.request("/api/events", { headers: { cookie, "accept-encoding": "gzip" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("content-encoding")).toBeNull();
    await res.body?.cancel();
  });
});
