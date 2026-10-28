import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("what leaves the server (Settings → Network)", () => {
  type Caller = ReturnType<typeof import("../router").appRouter.createCaller>;
  const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);
  let admin: Caller;
  let member: Caller;

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const user = async (name: string, role: string) => (await q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES (?, ?, ?, 1) RETURNING id", name, name, role))[0].id;
    const a = await user("a", "admin");
    const m = await user("m", "member");
    await q("INSERT INTO connections (user_id, type, base_url, remote_account_id, encrypted_secret, created_at) VALUES (?, 'jira', 'https://jira.example.it:8443', 'me', 'x', 1)", m);
    const { appRouter } = await import("../router");
    const { getDb } = await import("../queries/connection");
    const { users } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    const caller = async (id: number) => {
      const [row] = await getDb().select().from(users).where(eq(users.id, id));
      return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: row, sessionId: null });
    };
    admin = await caller(a);
    member = await caller(m);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the host a fetch goes to, never a path; the server's own loopback is not leaving", async () => {
    const { egressHost } = await import("./egress");
    expect(egressHost("https://Graph.Microsoft.com/v1.0/me/messages?$search=secret")).toBe("graph.microsoft.com");
    expect(egressHost(new URL("https://jira.example.it:8443/rest/api/2/issue/X-1"))).toBe("jira.example.it:8443");
    expect(egressHost(new Request("https://api.github.com/user"))).toBe("api.github.com");
    expect(egressHost("http://127.0.0.1:3000/api/health")).toBeNull();
    expect(egressHost("http://localhost:5432")).toBeNull();
    expect(egressHost("/api/trpc")).toBeNull();
  });

  it("counts every fetch once installed, answers and failures, and adds to what is stored", async () => {
    const { installEgressLog, flushEgress, noteEgress } = await import("./egress");
    // Older counts already stored: a flush adds to them.
    noteEgress("api.open-meteo.com", 200, 1000);
    await flushEgress();
    const answers = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 200 })).mockResolvedValueOnce(new Response("", { status: 503 })).mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", answers);
    installEgressLog({ underTests: true });
    await fetch("https://api.open-meteo.com/v1/forecast?latitude=45");
    await fetch("https://jira.example.it:8443/rest/api/2/myself");
    await expect(fetch("https://login.microsoftonline.com/organizations/oauth2/v2.0/token")).rejects.toThrow();
    await fetch("http://127.0.0.1:1/").catch(() => undefined);
    await flushEgress();
    const rows = await q<{ host: string; calls: number; failures: number; last_status: string }>("SELECT host, calls, failures, last_status FROM egress_hosts ORDER BY host");
    expect(rows).toEqual([
      { host: "api.open-meteo.com", calls: 2, failures: 0, last_status: "200" },
      { host: "jira.example.it:8443", calls: 1, failures: 1, last_status: "503" },
      { host: "login.microsoftonline.com", calls: 1, failures: 1, last_status: "error" },
    ]);
  });

  it("shows the server's admin what each host is for; a member may not see it", async () => {
    const list = await admin.egress.list();
    expect(Object.fromEntries(list.map(r => [r.host, r.purpose]))).toEqual({
      "api.open-meteo.com": { kind: "weather" },
      "jira.example.it:8443": { kind: "tracker", name: "Jira" },
      "login.microsoftonline.com": { kind: "microsoft" },
    });
    await expect(member.egress.list()).rejects.toThrow();
  });
});
