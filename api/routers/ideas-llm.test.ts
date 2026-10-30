// Suggestions from a local model (docs/work/ideas/triage.md R-2.8): only when one is configured, only local, only valid.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => [{ address: host === "gpu.lan" ? "192.168.1.40" : "93.184.216.34", family: 4 }]),
}));

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

async function caller() {
  const [{ id: userId }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES (?, ?, 1) RETURNING id", `u${Math.random()}`, "U");
  const { appRouter } = await import("../router");
  const { getDb } = await import("../queries/connection");
  const { users } = await import("@db/schema");
  const { eq } = await import("drizzle-orm");
  const [user] = await getDb().select().from(users).where(eq(users.id, userId));
  return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user, sessionId: null });
}

const { env } = await import("../lib/env");
const saved = { url: env.ollamaUrl, sim: env.ollamaSimulator, pub: env.ollamaAllowPublic };
afterEach(() => {
  env.ollamaUrl = saved.url;
  env.ollamaSimulator = saved.sim;
  env.ollamaAllowPublic = saved.pub;
});

describe("ideas.llm and ideas.suggest", () => {
  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
  });

  it("suggestions only from a configured local model", async () => {
    const c = await caller();
    const [idea] = await c.ideas.capture({ text: "Estimate issues" });
    // Nothing configured: not offered, refused.
    env.ollamaUrl = null;
    env.ollamaSimulator = null;
    expect(await c.ideas.llm()).toEqual({ available: false, model: null });
    await expect(c.ideas.suggest({ id: idea.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "No local model is set up on this server." });
    // A model on the network (simulated): a valid suggestion, nothing saved.
    env.ollamaSimulator = "1";
    expect((await c.ideas.llm()).available).toBe(true);
    const s = await c.ideas.suggest({ id: idea.id });
    expect(s.acceptance?.length).toBeGreaterThan(0);
    expect((await c.ideas.get({ id: idea.id })).acceptance).toEqual([]);
    // An answer that isn't what was asked: an error, no retry.
    env.ollamaSimulator = "garbage";
    await expect(c.ideas.suggest({ id: idea.id })).rejects.toMatchObject({ code: "BAD_GATEWAY", message: "The local model's answer couldn't be used: try again." });
    // Another user's idea: not found, whatever the model.
    env.ollamaSimulator = "1";
    await expect((await caller()).ideas.suggest({ id: idea.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a public model address is refused", async () => {
    const c = await caller();
    env.ollamaSimulator = null;
    env.ollamaUrl = "https://api.example.com";
    env.ollamaAllowPublic = false;
    expect(await c.ideas.llm()).toEqual({ available: false, model: null });
    const [idea] = await c.ideas.capture({ text: "Anything" });
    await expect(c.ideas.suggest({ id: idea.id })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    // On this network, or allowed on purpose: offered.
    env.ollamaUrl = "http://gpu.lan:11434";
    expect((await c.ideas.llm()).available).toBe(true);
    env.ollamaUrl = "https://api.example.com";
    env.ollamaAllowPublic = true;
    expect((await c.ideas.llm()).available).toBe(true);
  });
});
