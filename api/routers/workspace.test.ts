import { beforeAll, describe, expect, it, vi } from "vitest";
import { jiraSignIn } from "../testing/signIn";

process.env.DATABASE_URL = ":memory:";
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) }));
vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ accountId: "acc-1", displayName: "Mario", avatarUrls: {} }), { headers: { "Content-Type": "application/json" } })));

async function signedInCaller() {
  const { appRouter } = await import("../router");
  const resHeaders = new Headers();
  await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: "https://acme.atlassian.net", deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
  const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
  const { userFromRequest } = await import("../context");
  const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
  return appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: ctx.user, sessionId: ctx.sessionId });
}

describe("workspace router", () => {
  beforeAll(async () => {
    const { resetDbForTests } = await import("../queries/connection");
    await resetDbForTests();
  });

  it("refuses a scope the catalog does not have as a bad request, not a server error", async () => {
    const me = await signedInCaller();
    await expect(me.workspace.get({ scope: { surfaceId: "shell-desktop", deviceClass: "mobile" }, clientInstanceId: "tab-a" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns the default workspace only to an authenticated user", async () => {
    const me = await signedInCaller();
    const result = await me.workspace.get({ scope: { surfaceId: "dashboard", deviceClass: "desktop" }, clientInstanceId: "tab-a" });
    expect(result.workspace.sourceActiveRevision).toBe("default");
    expect(result.workspace.placements.length).toBeGreaterThan(0);
    expect(result.ssr).toMatchObject({ kind: "activate" });
    const { appRouter } = await import("../router");
    const anonymous = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: null, sessionId: null });
    await expect(anonymous.workspace.get({ scope: { surfaceId: "dashboard", deviceClass: "desktop" } })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses every mutation without a session", async () => {
    const { appRouter } = await import("../router");
    const anonymous = appRouter.createCaller({ req: new Request("http://localhost/"), resHeaders: new Headers(), user: null, sessionId: null });
    const scope = { surfaceId: "dashboard", deviceClass: "desktop" } as const;
    for (const call of [
      () => anonymous.workspace.rollback({ scope, clientInstanceId: "tab-a", targetRevision: "default" }),
      () => anonymous.workspace.commit({ scope, prepareId: "p", operationId: "o", clientInstanceId: "tab-a", draftRevision: 1, interactionEpoch: 1 }),
      () => anonymous.planner.interpret({ scope, originalText: "x" }),
      () => anonymous.flowMap.import({ contents: "{}" }),
      () => anonymous.flowMap.delete(),
    ]) await expect(call()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("keeps one user's revisions out of another's reach and says why in plain words", async () => {
    const me = await signedInCaller();
    const { q } = await import("../queries/connection");
    const { t } = await import("@contracts/i18n");
    const scope = { surfaceId: "dashboard", deviceClass: "desktop" } as const;
    const [{ id: otherId }] = await q<{ id: number }>("INSERT INTO users(display_name, created_at) VALUES ('Other', ?) RETURNING id", Date.now());
    await q("INSERT INTO workspace_revisions (id, user_id, surface_id, device_class, revision_number, catalog_version, product_default_version, committed_at, operations, constraints, status) VALUES ('wr_other', ?, 'dashboard', 'desktop', 1, '1.0.0', 'product-1', ?, '[]', '[]', 'committed')", otherId, Date.now());
    await expect(me.workspace.rollback({ scope, clientInstanceId: "tab-a", targetRevision: "wr_other" })).rejects.toMatchObject({ code: "CONFLICT", message: t("server.workspace.changed") });
    await expect(me.planner.evaluate({ scope, beforeEvidenceId: "evidence_x", afterEvidenceId: "evidence_y" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await q("SELECT user_id FROM workspace_revisions WHERE id = 'wr_other'")).toEqual([{ user_id: otherId }]);
    // A refused transition never shows its internal code.
    await expect(me.workspace.commit({ scope, prepareId: "missing", operationId: "o-missing", clientInstanceId: "tab-a", draftRevision: 1, interactionEpoch: 1 })).rejects.toMatchObject({ message: t("server.workspace.changed") });
  });

  it("does not let FlowMap analysis or deterministic suggestions run in a loop", async () => {
    const me = await signedInCaller();
    const scope = { surfaceId: "dashboard", deviceClass: "desktop" } as const;
    const codes: string[] = [];
    // FlowMap is off for this user: every call is refused cheaply until the limit, then throttled.
    for (let i = 0; i < 31; i++) codes.push(await me.flowMap.aggregate({ scope }).then(() => "OK", (error: { code: string }) => error.code));
    expect(codes.at(-1)).toBe("TOO_MANY_REQUESTS");
    await expect(me.flowMap.export({ scope, evidenceId: "evidence_x", view: "heat" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await expect(me.planner.suggest({ scope })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("does not let imports run in a loop", async () => {
    const me = await signedInCaller();
    const scope = { surfaceId: "dashboard", deviceClass: "desktop" } as const;
    const codes: string[] = [];
    for (let i = 0; i < 11; i++) codes.push(await me.planner.import({ scope, contents: "not json" }).then(() => "OK", (error: { code: string }) => error.code));
    expect(codes.slice(0, 10).every(code => code === "BAD_REQUEST")).toBe(true);
    expect(codes[10]).toBe("TOO_MANY_REQUESTS");
  });
});

