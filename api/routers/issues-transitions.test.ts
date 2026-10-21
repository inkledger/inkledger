import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

const SITE = "https://jira.example.it";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** What Jira received for the last transition. */
let posted: unknown = null;
let expanded = false;

const issue = (status: string) => ({
  id: "10001",
  key: "OPS-1",
  fields: { summary: "Resolve me", status: { name: status, statusCategory: { key: status === "Fatto" ? "done" : "indeterminate" } }, project: { key: "OPS", name: "Ops" }, labels: [] },
});
let status = "In corso";

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/myself")) return json({ name: "mrossi", key: "mrossi", displayName: "Mario", avatarUrls: {} });
    if (url.includes("/transitions") && method === "GET") {
      expanded = url.includes("expand=transitions.fields");
      return json({
        transitions: [
          {
            id: "31",
            name: "Risolvi",
            to: { name: "Fatto", statusCategory: { key: "done" } },
            fields: {
              resolution: { required: true, name: "Risoluzione", schema: { type: "resolution", system: "resolution" }, allowedValues: [{ id: "1", name: "Completato" }, { id: "2", name: "Non risolvibile" }] },
              customfield_9: { required: true, name: "Approvato da", schema: { type: "any", custom: "com.acme:approver" } },
            },
          },
          { id: "41", name: "Riapri", to: { name: "Da fare", statusCategory: { key: "new" } }, fields: { comment: { required: false, name: "Commento", schema: { type: "comment" } } } },
          { id: "51", name: "Chiudi", to: { name: "Chiuso", statusCategory: { key: "done" } }, fields: { resolution: { required: true, name: "Risoluzione", schema: { type: "resolution" }, allowedValues: [{ id: "1", name: "Completato" }] } } },
        ],
      });
    }
    if (url.includes("/transitions") && method === "POST") {
      posted = JSON.parse(String(init?.body));
      status = "Fatto";
      return new Response(null, { status: 204 });
    }
    if (url.includes("/search")) return json({ issues: [issue(status)], total: 1, isLast: true });
    if (/\/issue\/OPS-1(\?|$)/.test(url)) return json(issue(status));
    return json({ errorMessages: [`unmocked ${method} ${url}`] }, 500);
  }),
);

describe("transitions with the fields they ask for", () => {
  let caller: ReturnType<typeof import("../router").appRouter.createCaller>;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { appRouter } = await import("../router");
    const resHeaders = new Headers();
    await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: SITE, deployment: "server", username: "mrossi", secret: "p" });
    const { userFromRequest } = await import("../context");
    const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie: (resHeaders.get("set-cookie") ?? "").split(";")[0] } }));
    caller = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
    await caller.issues.sync();
  });

  it("lists each way on with what it asks for, and says which inkledger can carry out", async () => {
    const list = await caller.issues.transitions({ key: "OPS-1" });
    expect(expanded).toBe(true);
    const byId = new Map(list.map((tr) => [tr.id, tr]));
    expect(byId.get("31")).toMatchObject({ toStatus: "Fatto", executable: false, remoteUrl: `${SITE}/browse/OPS-1` });
    expect(byId.get("31")?.requirements.map((r) => [r.id, r.type])).toEqual([
      ["resolution", "choice"],
      ["customfield_9", "unknown"],
    ]);
    expect(byId.get("41")).toMatchObject({ requirements: [], executable: true });
    expect(byId.get("51")).toMatchObject({ executable: true, requirements: [{ id: "resolution", required: true, options: [{ id: "1", name: "Completato" }] }] });
  });

  it("refuses a transition without its fields, naming them; sends it with them", async () => {
    await expect(caller.issues.transition({ key: "OPS-1", toStatus: "Chiuso" })).rejects.toMatchObject({ code: "BAD_REQUEST", cause: { fields: { resolution: "required" } } });
    await expect(caller.issues.transition({ key: "OPS-1", transitionId: "51", fields: { resolution: "9" } })).rejects.toMatchObject({ cause: { fields: { resolution: "not a choice" } } });
    await expect(caller.issues.transition({ key: "OPS-1", transitionId: "31", fields: { resolution: "1" } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(posted).toBeNull();
    const moved = await caller.issues.transition({ key: "OPS-1", transitionId: "51", fields: { resolution: "1" } });
    expect(posted).toEqual({ transition: { id: "51" }, fields: { resolution: { id: "1" } } });
    expect(moved.to).toBe("Fatto");
  });
});
