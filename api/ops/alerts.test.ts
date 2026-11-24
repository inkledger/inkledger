// Alerts: a connection going bad is told once (one notification, one webhook),
// a repeat within the cooldown is not, and the webhook never reaches an address
// it must not (this server's neighbours, link-local, metadata).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

process.env.DATABASE_URL = ":memory:";

const q: typeof import("../queries/connection").q = async (text, ...params) => (await import("../queries/connection")).q(text, ...params);

/** A public address in a documentation range: allowed, and stubbed fetch answers it. */
const HOOK = "https://203.0.113.10/hooks/alerts";

describe("alerts", () => {
  let owner = 0;
  let admin = 0;
  let conn = 0;
  const posts: { url: string; body: string; headers: Headers }[] = [];

  beforeAll(async () => {
    await (await import("../queries/connection")).resetDbForTests();
    [{ id: owner }] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES ('o', 'O', 'member', 1) RETURNING id");
    [{ id: admin }] = await q<{ id: number }>("INSERT INTO users (username, display_name, role, created_at) VALUES ('a', 'A', 'admin', 1) RETURNING id");
    [{ id: conn }] = await q<{ id: number }>(
      "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 'gitlab', 'Work GitLab', 'https://gitlab.example', 'me', '{}', 'x', 1) RETURNING id",
      owner,
    );
  });

  beforeEach(async () => {
    posts.length = 0;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
      return new Response("ok", { status: 200 });
    });
    await q("DELETE FROM notifications");
    await q("UPDATE connections SET status = 'ok'");
    await (await import("./alerts")).resetAlertsForTests();
    await (await import("./alerts")).saveWebhook({ url: HOOK, format: "json" });
  });

  afterEach(() => vi.unstubAllGlobals());

  const alertsOf = (userId: number) => q<{ kind: string; connection_id: number | null; detail: string }>("SELECT kind, connection_id, detail FROM notifications WHERE user_id = ? ORDER BY id", userId);

  it("a connection refused in one pass, by two streams and the scheduler's mark: one notification, one webhook", async () => {
    const { failed } = await import("../sync/state");
    const { markConnection } = await import("../providers/connections");
    const { ProviderError } = await import("../providers/core/errors");
    const refused = new ProviderError("auth", "401 Unauthorized");
    await q("INSERT INTO connection_sync (connection_id, stream, lease_owner) VALUES (?, 'issues', ?), (?, 'entries', ?)", conn, "p", conn, "p");
    await failed(conn, "issues", refused);
    await failed(conn, "entries", refused);
    await markConnection(owner, conn, "auth_failed");

    expect((await q<{ status: string }>("SELECT status FROM connections WHERE id = ?", conn))[0].status).toBe("auth_failed");
    const told = await alertsOf(owner);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ kind: "alert", connection_id: conn });
    expect(JSON.parse(told[0].detail)).toEqual({ kind: "auth_failed", name: "Work GitLab" });
    // The connection's own: not every admin's.
    expect(await alertsOf(admin)).toHaveLength(0);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(HOOK);
    expect(JSON.parse(posts[0].body)).toMatchObject({ event: "alert", kind: "auth_failed", subject: `connection:${conn}`, name: "Work GitLab" });
  });

  it("the webhook is signed: HMAC-SHA256 of '<timestamp>.<body>' with the secret given when it was saved", async () => {
    const { saveWebhook, connectionAlertById } = await import("./alerts");
    const saved = await saveWebhook({ url: "https://203.0.113.11/other", format: "slack" });
    await connectionAlertById(conn, "unreachable");
    expect(posts).toHaveLength(1);
    const ts = posts[0].headers.get("x-inkledger-timestamp") ?? "";
    const expected = createHmac("sha256", saved?.secret ?? "").update(`${ts}.${posts[0].body}`).digest("hex");
    expect(posts[0].headers.get("x-inkledger-signature")).toBe(`sha256=${expected}`);
    expect(JSON.parse(posts[0].body)).toEqual({ text: expect.stringContaining("Work GitLab") as unknown });
  });

  it("the same subject within the cooldown is told once; past it, again", async () => {
    const { raiseAlert, resolveAlert } = await import("./alerts");
    const alert = { key: "backup", kind: "backup" as const, name: "backup" };
    const t0 = 1_800_000_000_000;
    expect(await raiseAlert(alert, t0)).toBe(true);
    // Works again, then fails again ten minutes later: still within the cooldown.
    await resolveAlert("backup");
    expect(await raiseAlert(alert, t0 + 10 * 60_000)).toBe(false);
    expect(await raiseAlert(alert, t0 + 7 * 3600_000)).toBe(true);
    // A server alert: to the admins, about no connection.
    const told = await alertsOf(admin);
    expect(told).toHaveLength(2);
    expect(told.every((n) => n.connection_id === null)).toBe(true);
    expect(await alertsOf(owner)).toHaveLength(0);
    expect(posts).toHaveLength(2);
  });

  it("failures in a row: told when the threshold is reached, not at every failure after", async () => {
    const { failed } = await import("../sync/state");
    const { ProviderError } = await import("../providers/core/errors");
    const { opsConfig } = await import("./config");
    await q("DELETE FROM connection_sync");
    for (let i = 0; i < opsConfig.alertFailures + 2; i++) {
      await q("INSERT INTO connection_sync (connection_id, stream, lease_owner) VALUES (?, 'inbox', 'x') ON CONFLICT (connection_id, stream) DO UPDATE SET lease_owner = 'x'", conn);
      const { PROCESS_ID } = await import("../sync/state");
      await q("UPDATE connection_sync SET lease_owner = ? WHERE connection_id = ?", PROCESS_ID, conn);
      await failed(conn, "inbox", new ProviderError("invalid", "422"));
    }
    const told = await alertsOf(owner);
    expect(told).toHaveLength(1);
    expect(JSON.parse(told[0].detail)).toEqual({ kind: "failures", name: "Work GitLab", count: opsConfig.alertFailures });
  });

  it("the summary drops a connection's alert once it works again", async () => {
    const { connectionAlertById, alertSummary } = await import("./alerts");
    await q("DELETE FROM connection_sync");
    await q("UPDATE connections SET status = 'auth_failed' WHERE id = ?", conn);
    await connectionAlertById(conn, "auth_failed");
    expect((await alertSummary()).map((a) => a.key)).toEqual([`connection:${conn}`]);
    await q("UPDATE connections SET status = 'ok' WHERE id = ?", conn);
    expect(await alertSummary()).toEqual([]);
  });

  it("a read-only server sends no webhook (a test server on a copied database)", async () => {
    const { env } = await import("../lib/env");
    const { sendWebhook } = await import("./alerts");
    const was = env.readOnly;
    (env as { readOnly: boolean }).readOnly = true;
    try {
      expect(await sendWebhook({ key: "x", kind: "backup", name: "backup" })).toBe(false);
    } finally {
      (env as { readOnly: boolean }).readOnly = was;
    }
    expect(posts).toHaveLength(0);
  });
});

describe("alert webhook URL (SSRF guard)", () => {
  const resolveTo = (addr: string) => async () => [addr];

  it.each([
    ["http://127.0.0.1:3000/x", undefined],
    ["http://localhost/x", undefined],
    ["http://db:5432/", undefined],
    ["http://169.254.169.254/latest/meta-data/", undefined],
    ["http://[::1]/x", undefined],
    ["http://[::ffff:127.0.0.1]/x", undefined],
    ["https://user:pw@hooks.example/x", undefined],
    ["ftp://hooks.example/x", undefined],
    ["file:///etc/passwd", undefined],
    ["https://metadata.example/x", resolveTo("169.254.169.254")],
    ["https://rebind.example/x", resolveTo("127.0.0.1")],
  ])("refuses %s", async (url, resolve) => {
    const { assertSafeWebhookUrl } = await import("./alerts");
    await expect(assertSafeWebhookUrl(url, resolve)).rejects.toThrow();
  });

  it("allows a chat service on the internet, or one on the company network", async () => {
    const { assertSafeWebhookUrl } = await import("./alerts");
    await expect(assertSafeWebhookUrl("https://hooks.slack.example/services/x", resolveTo("203.0.113.5"))).resolves.toBeUndefined();
    await expect(assertSafeWebhookUrl("https://chat.internal.example/hooks/x", resolveTo("10.0.0.8"))).resolves.toBeUndefined();
  });

  it("is checked again when sent: a name that now resolves inside is refused, nothing posted", async () => {
    process.env.DATABASE_URL = ":memory:";
    await (await import("../queries/connection")).initDb();
    const { saveWebhook, sendWebhook } = await import("./alerts");
    await saveWebhook({ url: "https://203.0.113.12/x", format: "json" });
    const { setServerSetting, getServerSetting } = await import("../lib/serverSettings");
    const { sealFor } = await import("../lib/crypto");
    const stored = await getServerSetting<{ url: string; secret: string; format: string }>("alerts.webhook", { url: "", secret: "", format: "json" });
    // As if stored before the guard (or edited in the database): the send refuses it all the same.
    await setServerSetting("alerts.webhook", { ...stored, url: sealFor("http://169.254.169.254/x", "alerts:webhook") });
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendWebhook({ key: "x", kind: "backup", name: "backup" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
