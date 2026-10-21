import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

import { categoryOfGroup, isClosed, priorityRankOf } from "@contracts/categories";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let priorities: "ok" | "down" = "ok";

// Jira Server in Italian: six priorities, its groups read by key.
const issue = (key: string, priority: string, group: string) => ({
  id: `id-${key}`,
  key,
  fields: { summary: key, status: { name: "Stato", statusCategory: { key: group, name: "localized" } }, priority: { name: priority }, project: { key: "OPS", name: "Ops" }, labels: [], assignee: { name: "mrossi" } },
});
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/myself")) return json({ name: "mrossi", key: "mrossi", displayName: "Mario", avatarUrls: {} });
    if (url.endsWith("/priority")) {
      if (priorities === "down") return json({ errorMessages: ["boom"] }, 500);
      return json(["Bloccante", "Critica", "Alta", "Media", "Bassa", "Minima"].map((name, i) => ({ id: String(i + 1), name })));
    }
    if (url.includes("/search")) return json({ issues: [issue("OPS-1", "Bloccante", "indeterminate"), issue("OPS-2", "Media", "done"), issue("OPS-3", "Minima", "new")], total: 3, isLast: true });
    return json({ errorMessages: [`unmocked ${url}`] }, 500);
  }),
);

describe("canonical categories and priority ranks", () => {
  it("rank a tracker's own order onto 0–4 (coarse on purpose), and group by category", () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => priorityRankOf(i, 6))).toEqual([0, 1, 2, 2, 3, 4]);
    expect(priorityRankOf(0, 1)).toBe(2);
    expect(priorityRankOf(0, 0)).toBeNull();
    expect(["To Do", "In Progress", "Done", "Custom"].map(categoryOfGroup)).toEqual(["todo", "doing", "done", "todo"]);
    expect(["done", "cancelled", "doing"].map(isClosed)).toEqual([true, true, false]);
  });

  it("a Jira sync stores each issue's category (by its group's key) and its priority's rank", async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: "https://jira.example.it", deployment: "server", username: "mrossi", secret: "p" });
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie: (resHeaders.get("set-cookie") ?? "").split(";")[0] } }));
    const caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
    await caller.issues.sync();
    const rows = async () => (await caller.issues.all()).map((i) => [i.key, i.category, i.priorityRank]);
    expect(await rows()).toEqual(
      expect.arrayContaining([
        ["OPS-1", "doing", 0],
        ["OPS-2", "done", 2],
        ["OPS-3", "todo", 4],
      ]),
    );
    // Priorities unreachable later: the ranks known stay.
    priorities = "down";
    (await import("../jira/priorities")).forgetPriorityRanks();
    await caller.issues.sync();
    expect(await rows()).toEqual(expect.arrayContaining([["OPS-1", "doing", 0]]));
  });
});
