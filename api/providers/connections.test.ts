import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("connections: where a user's tracker credentials come from", () => {
  async function fresh() {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    const { encrypt } = await import("../lib/crypto");
    // The account, and its Jira connection with the secret it signed in with (an older one, before sealing).
    const [user] = await conn.q<{ id: number }>("INSERT INTO users (email, display_name, created_at) VALUES ('mrossi', 'Mario', 1) RETURNING id");
    await conn.q(
      "INSERT INTO connections (user_id, type, base_url, remote_account_id, options, encrypted_secret, legacy, created_at) VALUES (?, 'jira', ?, 'mrossi', ?, ?, 1, 1)",
      user.id,
      "https://jira.example.org",
      JSON.stringify({ deployment: "server", authType: "bearer", username: "mrossi" }),
      encrypt("pat-123"),
    );
    return { q: conn.q, user: user };
  }

  it("are the ones the user signed in with", async () => {
    const { user } = await fresh();
    const { jiraCredentials } = await import("./connections");
    expect(await jiraCredentials(user)).toEqual({
      siteUrl: "https://jira.example.org",
      deployment: "server",
      authType: "bearer",
      username: "mrossi",
      secret: "pat-123",
    });
  });

  it("without a live connection, asks to connect one instead of failing", async () => {
    const { q, user } = await fresh();
    await q("UPDATE connections SET archived_at = 1");
    const { jiraCredentials, NoConnectionError } = await import("./connections");
    const err = await jiraCredentials(user).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(NoConnectionError);
  });

  it("an unreadable secret asks to reconnect the tracker (not to sign in again)", async () => {
    const { q, user } = await fresh();
    await q("UPDATE connections SET encrypted_secret = 'a.b.c'");
    const { jiraCredentials } = await import("./connections");
    const { UnreadableCredentialsError } = await import("../middleware");
    const err = await jiraCredentials(user).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(UnreadableCredentialsError);
  });
});
