import { describe, expect, it } from "vitest";
import { fromSecret, sealedText } from "../testing/sealedFixtures";

// No CREDENTIALS_KEY: everything is sealed with the key derived from SESSION_SECRET.
const SESSION = "only-a-session-secret";
process.env.DATABASE_URL = ":memory:";
process.env.CREDENTIALS_KEY = "";
process.env.CREDENTIALS_KEY_OLD = "";
process.env.SESSION_SECRET = SESSION;

describe("keys-status without CREDENTIALS_KEY", () => {
  it("says everything depends on SESSION_SECRET and to set CREDENTIALS_KEY first; reseal finds nothing to do", async () => {
    const { resetDbForTests, getDb, q } = await import("./connection");
    await resetDbForTests();
    await q("INSERT INTO users (id, username, display_name, created_at) VALUES (1, 'm', 'M', 0)");
    await q("INSERT INTO mail_accounts (user_id, account, secret, created_at, updated_at) VALUES (1, 'm@x', ?, 0, 0)", sealedText(fromSecret(SESSION), "{}", "mail:1"));
    const { keysStatus, resealAll } = await import("./sealedValues");
    const s = await keysStatus(getDb());
    expect(s.sealingKey).toBe("SESSION_SECRET");
    expect(s.columns.find((c) => c.column === "mail_accounts.secret")).toMatchObject({ total: 1, SESSION_SECRET: 1, CREDENTIALS_KEY: 0 });
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toMatch(/CREDENTIALS_KEY is not set.*Set CREDENTIALS_KEY, restart, run reseal --apply, and only then change SESSION_SECRET/);
    const r = await resealAll(getDb(), { apply: false });
    expect(r.columns.find((c) => c.column === "mail_accounts.secret")).toMatchObject({ current: 1, resealed: 0 });
  });
});
