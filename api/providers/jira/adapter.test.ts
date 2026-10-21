import { describe, expect, it, vi } from "vitest";
import { timeZone } from "@contracts/values";
import { bindTracker } from "../core/bind";
import { ProviderError } from "../core/errors";
import { trackerConformance } from "../conformance/suite";
import { jiraSimulator } from "./simulator";
import { jiraProvider } from "./adapter";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

function simulated() {
  const sim = jiraSimulator();
  sim.add("APP-1", "Login fails on Safari");
  sim.add("APP-2", "Export to CSV");
  sim.add("OPS-3", "Someone else's", undefined, "acc-other");
  vi.stubGlobal("fetch", sim.fetch);
  const conn = {
    id: 1,
    userId: 1,
    type: "jira" as const,
    baseUrl: sim.site,
    remoteAccountId: sim.me,
    options: { deployment: "cloud", authType: "basic", username: "sim@example.com" },
    timeZone: timeZone("Europe/Rome"),
    credential: async () => ({ kind: "token" as const, token: "token" }),
  };
  return { sim, conn };
}

// The real adapter and Jira client, against a Jira Cloud in memory.
trackerConformance("jira (Cloud, simulated)", async () => {
  const { sim, conn } = simulated();
  return { provider: jiraProvider, conn, key: "APP-1", writable: true, url: `${sim.site}/browse/APP-1` };
});

const meta = (signal = new AbortController().signal) => ({ signal, correlationId: "t" });
const kindOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof ProviderError ? e.kind : String(e)));

describe("jira: errors arrive in the layer's words", () => {
  it.each([
    [401, "auth"],
    [403, "forbidden"],
    [409, "conflict"],
    [429, "rateLimit"],
    [503, "unavailable"],
  ])("HTTP %i is %s", async (status, kind) => {
    const { sim, conn } = simulated();
    const b = bindTracker(jiraProvider, conn);
    sim.failNext(status);
    expect(await kindOf(b.verify(meta()))).toBe(kind);
  });

  it("a write on a read-only server is readOnly, never sent", async () => {
    vi.stubEnv("PROVIDERS_READ_ONLY", "1");
    vi.resetModules();
    const { jiraProvider: fresh } = await import("./adapter");
    const { bindTracker: bind } = await import("../core/bind");
    const { ProviderError: PE } = await import("../core/errors");
    const { conn } = simulated();
    const b = bind(fresh, conn);
    const err = await b.worklogs!.create!(meta(), { remoteId: "101", key: "APP-1" }, { time: { kind: "session", start: 1_760_000_000_000 as never, seconds: 60 }, comment: "x" }, { idempotencyKey: "k" }).catch((e: unknown) => e);
    expect(err instanceof PE && err.kind).toBe("readOnly");
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("cancelling a call under way stops its request", async () => {
    const { sim, conn } = simulated();
    const b = bindTracker(jiraProvider, conn);
    sim.slow(5_000);
    const ctl = new AbortController();
    const call = b.verify(meta(ctl.signal));
    setTimeout(() => ctl.abort(), 20);
    expect(await kindOf(call)).toBe("cancelled");
  });

  it("an issue that moved is still found by its id (a stale key in the reference)", async () => {
    const { sim, conn } = simulated();
    const b = bindTracker(jiraProvider, conn);
    const found = await b.findIssue(meta(), { key: "APP-2" });
    if (found.kind !== "found") throw new Error("no issue");
    sim.move("APP-2", "NEW-7");
    const again = await b.getIssue(meta(), { remoteId: found.issue.remoteId, key: "APP-2" });
    expect(again?.key).toBe("NEW-7");
  });
});
