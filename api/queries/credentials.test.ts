import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("credentials sealed again at start", () => {
  it("an older secret is sealed for its connection; a sealed one stays; one no key opens is left", async () => {
    const { resetDbForTests, getDb, q } = await import("./connection");
    await resetDbForTests();
    const { encrypt, openSecret, sealSecret } = await import("../lib/crypto");
    const { resealCredentials } = await import("./credentials");
    await q("INSERT INTO users (id, username, display_name, created_at) VALUES (1, 'm', 'M', 0)");
    const add = (id: number, secret: string) =>
      q("INSERT INTO connections (id, user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, 1, 'jira', ?, 'me', '{}', ?, 0)", id, `https://s${id}.example`, secret);
    await add(1, encrypt("old"));
    await add(2, sealSecret("new", 2));
    await add(3, "garbage.garbage.garbage");
    expect(await resealCredentials(getDb())).toBe(1);
    const rows = await q<{ id: number; encrypted_secret: string }>("SELECT id, encrypted_secret FROM connections ORDER BY id");
    expect(openSecret(rows[0].encrypted_secret, 1)).toEqual({ plain: "old", fresh: true });
    expect(openSecret(rows[1].encrypted_secret, 2)).toEqual({ plain: "new", fresh: true });
    expect(rows[2].encrypted_secret).toBe("garbage.garbage.garbage");
    // Nothing left to do the next time.
    expect(await resealCredentials(getDb())).toBe(0);
  });

  it("a connection marked unreadable that opens now works again; a refused login stays refused", async () => {
    const { getDb, q } = await import("./connection");
    const { encrypt } = await import("../lib/crypto");
    const { resealCredentials } = await import("./credentials");
    await q("INSERT INTO connections (id, user_id, type, base_url, remote_account_id, options, encrypted_secret, status, created_at) VALUES (4, 1, 'jira', 'https://s4.example', 'me', '{}', ?, 'unreadable', 0)", encrypt("back"));
    await q("INSERT INTO connections (id, user_id, type, base_url, remote_account_id, options, encrypted_secret, status, created_at) VALUES (5, 1, 'jira', 'https://s5.example', 'me', '{}', ?, 'auth_failed', 0)", encrypt("refused"));
    await resealCredentials(getDb());
    expect(await q("SELECT id, status FROM connections WHERE id IN (4, 5) ORDER BY id")).toEqual([{ id: 4, status: "ok" }, { id: 5, status: "auth_failed" }]);
  });
});
