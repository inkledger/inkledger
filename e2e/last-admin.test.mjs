// Two admins turning each other off at the same moment: on the real Postgres the
// server runs on (two connections), one of them must stay. It used to leave none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { start } from "./harness.mjs";

test("two admins turning each other off at once leave one of them on", async () => {
  const app = await start({ bare: true });
  try {
    const { base, db } = app;
    const port = new URL(base).port;
    const now = Date.now();
    await db.q("DELETE FROM users");
    const admin = async name => {
      const [{ id }] = await db.q("INSERT INTO users (username, display_name, role, created_at) VALUES (?, ?, 'admin', ?) RETURNING id", name, name, now);
      const cookie = randomBytes(32).toString("base64url");
      await db.q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", createHash("sha256").update(cookie).digest("hex"), id, now + 86_400_000, now);
      return { id, cookie: `ikl_session_${port}=${cookie}` };
    };
    for (let round = 0; round < 10; round++) {
      await db.q("DELETE FROM sessions");
      await db.q("DELETE FROM users");
      const [a, b] = [await admin(`a${round}`), await admin(`b${round}`)];
      const turnOff = (who, id) =>
        fetch(`${base}/api/trpc/users.setDisabled`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: who.cookie, origin: base },
          body: JSON.stringify({ json: { id, disabled: true } }),
        });
      const answers = await Promise.all([turnOff(a, b.id), turnOff(b, a.id)]);
      const [{ n }] = await db.q("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL");
      assert.equal(n, 1, `round ${round}: one admin stays on (answers ${answers.map(r => r.status)})`);
      // One done; the other refused as the last admin, or, if it came that late, as signed out already.
      const [done, refused] = answers.map(r => r.status).sort();
      assert.equal(done, 200, `round ${round}: one done`);
      assert.ok(refused === 400 || refused === 401, `round ${round}: the other refused (${refused})`);
    }
  } finally {
    await app.stop();
  }
});
