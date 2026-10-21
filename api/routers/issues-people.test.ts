import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

/** Raw SQL on the test database (Postgres, "?" placeholders). */
const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://acme.atlassian.net";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let issueGets = 0;
const remote = (key: string, assignee: { accountId: string; displayName: string } | null) => ({
  id: key,
  key,
  fields: {
    summary: `Issue ${key}`,
    status: { name: "To Do", statusCategory: { key: "new" } },
    project: { key: key.split("-")[0], name: "P" },
    assignee,
    reporter: { displayName: "Giulia Bianchi" },
    created: "2026-10-01T10:00:00.000+0200",
    updated: "2026-10-02T10:00:00.000+0200",
  },
});

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/myself")) {
      return json({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} });
    }
    const single = /\/issue\/([A-Z]+-\d+)$/.exec(url.pathname);
    if (/\/issue\/P-1\/changelog$/.test(url.pathname)) {
      return json({
        isLast: true,
        values: [
          {
            created: "2026-10-03T10:00:00.000+0200",
            author: { displayName: "Luca Verdi" },
            items: [{ field: "status", fromString: "To Do", toString: "In Progress" }],
          },
        ],
      });
    }
    if (/\/issue\/P-1\/comment$/.test(url.pathname)) return json({ comments: [] });
    if (single?.[1] === "NOPE-1") return json({ errorMessages: ["Issue does not exist"] }, 404);
    if (single) {
      issueGets++;
      expect(url.searchParams.get("fields")).toContain("reporter");
      return json(
        single[1] === "P-2"
          ? remote("P-2", null)
          : remote(single[1], { accountId: "acc-9", displayName: "Luca Verdi" }),
      );
    }
    return json({ errorMessages: [`unmocked ${url.pathname}`] }, 500);
  }),
);

describe("issue people and dates", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
    const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
    caller = appRouter.createCaller({
      req: new Request("http://localhost/"),
      resHeaders: new Headers(),
      user: ctx.user,
      sessionId: ctx.sessionId,
    });
  });

  it("stores assignee and reporter names with the issue", async () => {
    await caller.issues.import({ key: "P-1" });
    await caller.issues.import({ key: "P-2" });
    const one = await caller.issues.get({ key: "P-1" });
    expect([one.assigneeName, one.reporterName]).toEqual(["Luca Verdi", "Giulia Bianchi"]);
    expect(one.remoteCreatedAt).toBeTruthy();
    const unassigned = await caller.issues.get({ key: "P-2" });
    expect([unassigned.assigneeId, unassigned.assigneeName]).toEqual(["", ""]);
  });

  it("fills the names once for rows synced before they existed", async () => {
    (await q("UPDATE issues SET assignee_name = NULL, reporter_name = NULL WHERE key = 'P-1'"));
    const before = issueGets;
    expect((await caller.issues.get({ key: "P-1" })).reporterName).toBe("Giulia Bianchi");
    expect(issueGets).toBe(before + 1);
    await caller.issues.get({ key: "P-1" });
    expect(issueGets).toBe(before + 1); // not again
  });

  it("opens an issue that is not in the catalog live from Jira, without importing it", async () => {
    const before = ((await q("SELECT count(*) n FROM issues"))[0] as { n: number }).n;
    const live = await caller.issues.get({ key: "EXT-5" });
    expect(live).toMatchObject({ key: "EXT-5", remote: true, assigneeName: "Luca Verdi", favorite: 0 });
    expect(((await q("SELECT count(*) n FROM issues"))[0] as { n: number }).n).toBe(before);
    expect((await caller.issues.get({ key: "P-1" })).remote).toBe(false);
    await expect(caller.issues.get({ key: "NOPE-1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("history (Cloud): paged changelog plus creation, with the reason", async () => {
    const h = await caller.issues.history({ key: "P-1" });
    expect(h.events.map((e) => e.kind)).toEqual(["change", "created"]);
    expect(h.reason).toBe("Status: To Do → In Progress by Luca Verdi");
  });
});
