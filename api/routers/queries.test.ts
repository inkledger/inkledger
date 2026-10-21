import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "140.82.112.6", family: 4 }]),
}));

import { githubSimulator } from "../providers/github/simulator";

const sim = githubSimulator();
sim.add("acme/web", "Login fails");
vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => sim.fetch(input, init));

describe("searches kept, and keys or links pasted", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let caller: Caller;
  let other: Caller;
  let conn = 0;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { sealSecret } = await import("../lib/crypto");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('s', 'S', 1) RETURNING id");
    const [o] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('o', 'O', 1) RETURNING id");
    const [c] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'github', 'https://api.github.com', '4242', '{}', 'x', 1) RETURNING id", u.id);
    conn = c.id;
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("t", c.id), c.id);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const as = async (id: number) => {
      const [user] = await getDb().select().from(users).where(eq(users.id, id));
      return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
    };
    caller = await as(u.id);
    other = await as(o.id);
  });

  it("keeps searches in English, the last ten used, saved ones by name (a name used again overwrites)", async () => {
    expect((await caller.queries.used({ query: "progetto:APP assegnata:io" })).query).toBe("project:APP assignee:me");
    for (let i = 0; i < 12; i++) await caller.queries.used({ query: `word${i}` });
    await caller.queries.used({ query: "word3" });
    const { recent } = await caller.queries.list();
    expect(recent).toHaveLength(10);
    expect(recent[0]).toBe("word3");
    expect(recent).not.toContain("project:APP assignee:me");
    await caller.queries.save({ name: "Mine", query: "@io aperta" });
    const { id } = await caller.queries.save({ name: "mine", query: "@me is:closed" });
    expect((await caller.queries.list()).saved).toEqual([{ id, name: "Mine", query: "@me is:closed" }]);
    expect((await other.queries.list()).saved).toEqual([]);
    await expect(other.queries.delete({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await caller.queries.delete({ id });
    await caller.queries.clearRecent();
    expect(await caller.queries.list()).toEqual({ saved: [], recent: [] });
  });

  it("a pasted key or link names its issue, from the catalogue or asked of its tracker", async () => {
    expect(await caller.issues.open({ text: "https://github.com/acme/web/issues/1" })).toEqual([{ connectionId: conn, key: "acme/web#1", remoteId: expect.any(String), inCatalogue: false }]);
    await caller.issues.sync();
    expect(await caller.issues.open({ text: "acme/web#1" })).toEqual([{ connectionId: conn, key: "acme/web#1", remoteId: expect.any(String), inCatalogue: true }]);
    expect(await caller.issues.open({ text: "acme/web#99" })).toEqual([]);
    expect(await caller.issues.open({ text: "just words" })).toEqual([]);
  });
});
