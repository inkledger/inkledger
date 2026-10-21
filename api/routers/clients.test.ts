import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "140.82.112.6", family: 4 }]),
}));

import { githubSimulator } from "../providers/github/simulator";

const sim = githubSimulator();
sim.add("acme/web", "Login fails");
sim.add("acme/api", "Rate limits");
sim.add("bigco/app", "Billing export");
vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => sim.fetch(input, init));

describe("clients: who the work is for, across trackers", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  let caller: Caller;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { sealSecret } = await import("../lib/crypto");
    const [u] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('c', 'C', 1) RETURNING id");
    const [c] = await q<{ id: number }>("INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'github', 'https://api.github.com', '4242', '{}', 'x', 1) RETURNING id", u.id);
    await q("UPDATE connections SET encrypted_secret = ? WHERE id = ?", sealSecret("t", c.id), c.id);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const [user] = await getDb().select().from(users).where(eq(users.id, u.id));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
    await caller.issues.sync();
  });

  it("suggests a client per owner, and one made from it searches with client: (or its other names)", async () => {
    const suggested = await caller.clients.suggestions();
    expect(suggested.map((s) => [s.name, s.containerIds.length])).toEqual([
      ["acme", 2],
      ["bigco", 1],
    ]);
    const acme = suggested[0];
    await caller.clients.save({ name: "Acme", aliases: ["ACME Corp"], containerIds: acme.containerIds });
    // A client made is no longer suggested.
    expect((await caller.clients.suggestions()).map((s) => s.name)).toEqual(["bigco"]);
    const found = async (search: string) => (await caller.issues.list({ search, includeDone: true, includeUnassigned: true })).issues.map((i) => i.key).sort();
    expect(await found("client:acme")).toEqual(["acme/api#1", "acme/web#1"]);
    expect(await found('cliente:"acme corp"')).toEqual(["acme/api#1", "acme/web#1"]);
    expect(await found("-client:acme")).toEqual(["bigco/app#1"]);
  });

  it("a project is one client's: given to another, it moves; hours are reported by client", async () => {
    const { clients, containers } = await caller.clients.list();
    const web = containers.find((c) => c.key === "acme/web")!;
    const { id: other } = await caller.clients.save({ name: "Web team", containerIds: [web.id] });
    const after = await caller.clients.list();
    expect(after.clients.find((c) => c.id === clients[0].id)!.containerIds).not.toContain(web.id);
    expect(after.clients.find((c) => c.id === other)!.containerIds).toEqual([web.id]);
    await caller.worklogs.create({ issueKey: "acme/web#1", seconds: 3600, started: "2026-10-14T09:00:00+02:00", comment: "" });
    await caller.worklogs.create({ issueKey: "bigco/app#1", seconds: 1800, started: "2026-10-14T11:00:00+02:00", comment: "" });
    const report = await caller.reports.generate({ from: "2026-10-12", to: "2026-10-19", groupBy: "client" });
    expect(report.rows.map((r) => [r.label, r.seconds])).toEqual([
      ["Web team", 3600],
      ["No client", 1800],
    ]);
  });

  it("only the user's own projects, and only their own clients", async () => {
    await expect(caller.clients.save({ name: "Sneaky", containerIds: [999999] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.clients.delete({ id: 999999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
