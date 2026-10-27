import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubTokenSet } from "./oauth";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "140.82.112.6", family: 4 }]),
}));

const tokens = (overrides: Partial<GitHubTokenSet> = {}): GitHubTokenSet => ({
  v: 1,
  accessToken: "gho_old",
  accessTokenExpiresAt: Date.now() + 4 * 60_000,
  refreshToken: "ghr_old",
  refreshTokenExpiresAt: Date.now() + 30 * 24 * 60 * 60_000,
  ...overrides,
});

async function fresh(secret: GitHubTokenSet | string, options = "{}") {
  const connection = await import("../../queries/connection");
  await connection.resetDbForTests();
  const { users, connections } = await import("@db/schema");
  const { sealSecret } = await import("../../lib/crypto");
  const { serializeGitHubTokenSet } = await import("./oauth");
  const db = connection.getDb();
  const [user] = await db
    .insert(users)
    .values({ username: "mario", displayName: "Mario" })
    .returning();
  const [row] = await db
    .insert(connections)
    .values({
      userId: user.id,
      type: "github",
      baseUrl: "https://api.github.com",
      remoteAccountId: "4242",
      options,
      encryptedSecret: "",
      status: "ok",
    })
    .returning();
  const plain =
    typeof secret === "string" ? secret : serializeGitHubTokenSet(secret);
  const [saved] = await db
    .update(connections)
    .set({ encryptedSecret: sealSecret(plain, row.id) })
    .where((await import("drizzle-orm")).eq(connections.id, row.id))
    .returning();
  return { row: saved, q: connection.q };
}

async function savedTokens(
  id: number,
  q: Awaited<ReturnType<typeof fresh>>["q"]
) {
  const [row] = await q<{ encrypted_secret: string }>(
    "SELECT encrypted_secret FROM connections WHERE id = ?",
    id
  );
  const { openSecret } = await import("../../lib/crypto");
  const { parseGitHubTokenSet } = await import("./oauth");
  return {
    tokens: parseGitHubTokenSet(openSecret(row.encrypted_secret, id).plain),
    encrypted: row.encrypted_secret,
  };
}

describe("GitHub OAuth token sets", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reads every field, keeps long-lived answers and legacy secrets compatible", async () => {
    const {
      gitHubTokenSetFromResponse,
      parseGitHubTokenSet,
      serializeGitHubTokenSet,
    } = await import("./oauth");
    const full = gitHubTokenSetFromResponse(
      {
        access_token: "gho_new",
        expires_in: 28_800,
        refresh_token: "ghr_new",
        refresh_token_expires_in: 15_552_000,
      },
      1_000
    );
    expect(full).toEqual({
      v: 1,
      accessToken: "gho_new",
      accessTokenExpiresAt: 28_801_000,
      refreshToken: "ghr_new",
      refreshTokenExpiresAt: 15_552_001_000,
    });
    expect(parseGitHubTokenSet(serializeGitHubTokenSet(full))).toEqual(full);
    expect(
      gitHubTokenSetFromResponse({ access_token: "gho_long" }, 1_000)
    ).toEqual({
      v: 1,
      accessToken: "gho_long",
      accessTokenExpiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    });
    expect(parseGitHubTokenSet("gho_legacy")).toEqual({
      v: 1,
      accessToken: "gho_legacy",
      accessTokenExpiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    });
  });

  it("returns a fresh token without a refresh and exposes no token through the credential metadata", async () => {
    const { row } = await fresh(
      tokens({ accessTokenExpiresAt: Date.now() + 60 * 60_000 })
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { connOf } = await import("../connections");
    const credential = await connOf(row).credential();
    expect(credential).toMatchObject({ kind: "oauth", accessToken: "gho_old" });
    expect(
      credential.kind === "oauth" && credential.expiresAt! > Date.now()
    ).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(credential)).not.toContain("ghr_old");
  });

  it("keeps a legacy token usable without trying to rotate it", async () => {
    const { row } = await fresh("gho_legacy");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { connOf } = await import("../connections");
    await expect(connOf(row).credential()).resolves.toEqual({
      kind: "oauth",
      accessToken: "gho_legacy",
      expiresAt: null,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refreshes inside the five-minute margin and atomically persists the rotated token set encrypted", async () => {
    const { row, q } = await fresh(tokens());
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input instanceof Request ? input.url : input)).toBe(
          "https://github.com/login/oauth/access_token"
        );
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.has("client_secret")).toBe(false);
        return Response.json({
          access_token: "gho_new",
          expires_in: 28_800,
          refresh_token: "ghr_new",
          refresh_token_expires_in: 15_552_000,
        });
      }
    );
    vi.stubGlobal("fetch", fetcher);
    const { connOf } = await import("../connections");
    await expect(connOf(row).credential()).resolves.toMatchObject({
      kind: "oauth",
      accessToken: "gho_new",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const saved = await savedTokens(row.id, q);
    expect(saved.tokens).toMatchObject({
      accessToken: "gho_new",
      refreshToken: "ghr_new",
    });
    expect(saved.encrypted).not.toContain("gho_new");
    expect(saved.encrypted).not.toContain("ghr_new");
  });

  it("coalesces concurrent proactive refreshes into one OAuth request", async () => {
    const { row } = await fresh(tokens());
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const fetcher = vi.fn(async () => {
      await gate;
      return Response.json({
        access_token: "gho_new",
        expires_in: 28_800,
        refresh_token: "ghr_new",
        refresh_token_expires_in: 15_552_000,
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const { connOf } = await import("../connections");
    const conn = connOf(row);
    const pending = Promise.all(
      Array.from({ length: 20 }, () => conn.credential())
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    release();
    const credentials = await pending;
    expect(
      credentials.every(c => c.kind === "oauth" && c.accessToken === "gho_new")
    ).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rereads after the advisory lock and uses a token already rotated elsewhere", async () => {
    const initial = tokens();
    const { row, q } = await fresh(initial);
    const rotated = tokens({
      accessToken: "gho_other",
      accessTokenExpiresAt: Date.now() + 60 * 60_000,
      refreshToken: "ghr_other",
    });
    const { storeGitHubTokenSet, connOf } = await import("../connections");
    await storeGitHubTokenSet(row.id, rotated);
    const stale = { ...row };
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(connOf(stale).credential()).resolves.toMatchObject({
      accessToken: "gho_other",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await savedTokens(row.id, q)).tokens.refreshToken).toBe(
      "ghr_other"
    );
  });

  it("does not rotate again after a 401 when the rejected access token has already changed", async () => {
    const { row } = await fresh(
      tokens({
        accessToken: "gho_current",
        accessTokenExpiresAt: Date.now() + 60 * 60_000,
        refreshToken: "ghr_current",
      })
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { connOf } = await import("../connections");
    await expect(
      connOf(row).refreshCredential!("force", "gho_rejected")
    ).resolves.toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "bad_refresh_token",
      response: () =>
        Response.json({ error: "bad_refresh_token" }, { status: 400 }),
      kind: "auth",
    },
    {
      name: "a server error",
      response: () => Response.json({ message: "down" }, { status: 503 }),
      kind: "unavailable",
    },
    {
      name: "a network failure",
      response: () => Promise.reject(new TypeError("fetch failed")),
      kind: "unavailable",
    },
  ])(
    "maps $name without changing the connection status",
    async ({ response, kind }) => {
      const { row, q } = await fresh(tokens());
      vi.stubGlobal("fetch", vi.fn(response));
      const { connOf } = await import("../connections");
      await expect(connOf(row).credential()).rejects.toMatchObject({ kind });
      expect(
        await q("SELECT status FROM connections WHERE id = ?", row.id)
      ).toEqual([{ status: "ok" }]);
    }
  );

  it("treats an expired refresh token as an authentication failure without calling GitHub", async () => {
    const { row } = await fresh(
      tokens({ refreshTokenExpiresAt: Date.now() - 1 })
    );
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const { connOf } = await import("../connections");
    await expect(connOf(row).credential()).rejects.toMatchObject({
      kind: "auth",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("lets a manual reconnection win over a concurrent refresh without touching options", async () => {
    const options = JSON.stringify({
      excludeRepos: ["acme/web"],
      mine: "assigned",
    });
    const { row, q } = await fresh(tokens(), options);
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const fetcher = vi.fn(async () => {
      await gate;
      return Response.json({
        access_token: "gho_refreshed",
        expires_in: 28_800,
        refresh_token: "ghr_refreshed",
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const { connOf, storeGitHubTokenSet } = await import("../connections");
    const refreshing = connOf(row).credential();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const authorized = tokens({
      accessToken: "gho_authorized",
      accessTokenExpiresAt: Date.now() + 60 * 60_000,
      refreshToken: "ghr_authorized",
    });
    const reconnecting = storeGitHubTokenSet(row.id, authorized);
    release();
    await Promise.all([refreshing, reconnecting]);
    expect((await savedTokens(row.id, q)).tokens).toMatchObject({
      accessToken: "gho_authorized",
      refreshToken: "ghr_authorized",
    });
    expect(
      await q("SELECT options FROM connections WHERE id = ?", row.id)
    ).toEqual([{ options }]);
  });
});
