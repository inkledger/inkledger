import { describe, expect, it, vi } from "vitest";
import { timeZone } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { readPass } from "../core/paging";
import { trackerConformance } from "../conformance/suite";
import { githubSimulator } from "./simulator";
import { githubProvider } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "140.82.112.6", family: 4 }]),
}));

function simulated() {
  const sim = githubSimulator();
  sim.add("acme/web", "Login fails on Safari", { body: "Steps:\n\n1. open\n2. **fail**" });
  sim.add("acme/web", "Export to CSV");
  sim.add("acme/web", "A pull request", { pr: true });
  sim.add("acme/api", "Someone else's", { assignee: null });
  // Watched, not a member: outside the feed, read on its own.
  sim.repo("oss/lib", { member: false, watched: true });
  sim.add("oss/lib", "Crash on start", { assignee: null });
  // Neither: never read.
  sim.repo("stranger/repo", { member: false });
  sim.add("stranger/repo", "Not followed", { assignee: null });
  // A repository with no issue yet.
  sim.repo("acme/empty");
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 7,
    userId: 1,
    type: "github" as const,
    baseUrl: sim.apiBase,
    remoteAccountId: String(sim.me.id),
    options: {},
    timeZone: timeZone("Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: "gho_test" }),
  };
  return { sim, conn };
}

trackerConformance("github (simulated)", async () => {
  const { conn } = simulated();
  return { provider: githubProvider, conn, key: "acme/web#1", writable: true, url: "https://github.com/acme/web/issues/1" };
});

const meta = () => ({ signal: new AbortController().signal, correlationId: "t" });

describe("github, as the layer sees it", () => {
  it("lists every issue of the repositories the user follows (member or watched), no pull requests, keyed owner/repo#n", async () => {
    const { conn } = simulated();
    const b = bindTracker(githubProvider, conn);
    const all = await readPass((q) => b.listChanged(meta(), q), null);
    expect(all.items.map((i) => [i.key, i.container.key, i.status.name])).toEqual([
      ["acme/web#1", "acme/web", "Open"],
      ["acme/web#2", "acme/web", "Open"],
      ["acme/api#1", "acme/api", "Open"],
      ["oss/lib#1", "oss/lib", "Open"],
    ]);
    // Every repository, even one with no issue yet (a bucket can pick it).
    expect((await b.containers!(meta())).map((c) => c.key).sort()).toEqual(["acme/api", "acme/empty", "acme/web", "oss/lib"]);
    // Repositories left out by the user are neither read nor listed.
    const narrow = bindTracker(githubProvider, { ...conn, options: { excludeRepos: ["acme/api", "OSS/lib"] } });
    expect((await readPass((q) => narrow.listChanged(meta(), q), null)).items.map((i) => i.key)).toEqual(["acme/web#1", "acme/web#2"]);
    expect((await narrow.containers!(meta())).map((c) => c.key).sort()).toEqual(["acme/empty", "acme/web"]);
    expect((await b.description!(meta(), { remoteId: all.items[0].remoteId, key: "acme/web#1" }))?.kind).toBe("text");
  });

  it("closes as not planned (cancelled), reopens; comments in GFM", async () => {
    const { conn } = simulated();
    const b = bindTracker(githubProvider, conn);
    const ref = { remoteId: "I_1001", key: "acme/web#1" };
    const closed = await b.transitions!.apply!(meta(), ref, "not_planned", {});
    expect(closed?.status).toMatchObject({ name: "Not planned", category: "cancelled", nativeReason: "not_planned" });
    expect((await b.transitions!.list!(meta(), ref)).map((t) => t.name)).toEqual(["Reopen", "Close as completed"]);
    await b.comments!.add!(meta(), ref, "Looks **fixed**" as never, { idempotencyKey: "c1" });
    expect((await b.comments!.list(meta(), ref)).map((c) => c.body)).toEqual([{ kind: "text", format: "gfm", text: "Looks **fixed**" }]);
  });

  it("a spent quota is a wait, not a refusal", async () => {
    const { conn } = simulated();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 120) } }));
    const b = bindTracker(githubProvider, conn);
    const err = await b.verify(meta()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "rateLimit" });
    expect((err as { rateLimit?: { retryAfterMs?: number } }).rateLimit?.retryAfterMs).toBeGreaterThan(60_000);
  });
});
