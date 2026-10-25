import { beforeAll, describe, expect, it, vi } from "vitest";

// Production, with no REMOTE_ALLOWED_HOSTS: a self-hosted tracker reaches the private network.
process.env.DATABASE_URL = ":memory:";
process.env.NODE_ENV = "production";
process.env.SESSION_SECRET = "s".repeat(64);
process.env.REMOTE_ALLOWED_HOSTS = "";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "10.0.0.7", family: 4 }]),
}));
// Nothing leaves the test: the token check fails as a tracker out of reach would.
vi.stubGlobal("fetch", () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } })));

describe("self-hosted trackers in production without an allowlist", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const callerFor = async (username: string, role: "admin" | "member"): Promise<Caller> => {
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const [user] = await getDb().insert(users).values({ username, displayName: username, role }).returning();
    return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
  };
  let member: Caller;
  let admin: Caller;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    member = await callerFor("member", "member");
    admin = await callerFor("boss", "admin");
  });

  it("a member can't connect one (it would reach any address the server can); an admin can", async () => {
    const add = (c: Caller) => c.connections.connectToken({ type: "gitlab", baseUrl: "https://gitlab.internal", token: "glpat-xxxxxxxx", label: "Work" });
    await expect(add(member)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Past the gate: the token check itself fails here (no network in tests), not the permission.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(add(admin)).rejects.not.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      quiet.mockRestore();
    }
  });

  it("the same for a Jira Server/Data Center site", async () => {
    await expect(member.connections.addJira({ siteUrl: "https://jira.internal", deployment: "server", authType: "basic", username: "m", secret: "p", label: "Work" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
