// Two server processes on one database (a restart overlapping the old one, or
// two containers): a user's time writes still go one at a time, so the
// overlap rule holds across them. Real Postgres, no browser steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { APP, adminUrl, start } from "./harness.mjs";
import { freePort } from "../scripts/freePort.mjs";

let github = 0;
const seed = async db => {
  const now = Date.now();
  [{ id: github }] = await db.q(
    "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
    now,
  );
  await db.q(
    `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
     VALUES (1, ?, 'I_1', 'acme/web#1', 'One', 'Open', 'To Do', 'todo', 'acme/web', 'acme/web', 'Issue', '', '[]', '4242', 'https://github.com/acme/web/issues/1', ?)`,
    github, now,
  );
  await db.q("INSERT INTO settings (user_id, overlap_policy) VALUES (1, 'block') ON CONFLICT (user_id) DO UPDATE SET overlap_policy = 'block'");
};

/** A second server process on the app's database, up and answering. */
async function secondServer(db) {
  const [{ name }] = await db.q("SELECT current_database() AS name");
  // The same Postgres the harness made the app's database on.
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/boot.js"], {
    cwd: APP,
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), DATABASE_URL: url.toString(), SESSION_SECRET: randomBytes(32).toString("hex"), JIRA_READ_ONLY: "1", PROVIDERS_READ_ONLY: "1", SYNC_INTERVAL_MIN: "0", STORE_URL: "off", WEATHER: "off", TZ: "Europe/Rome" },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error("the second server stopped");
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (i > 300) throw new Error("the second server did not start");
    await new Promise(r => setTimeout(r, 100));
  }
  return { base, port, stop: () => new Promise(r => { child.once("exit", r); child.kill("SIGTERM"); }) };
}

test("two server processes: overlapping worklogs sent to both at once, one lands and one is refused", async () => {
  const app = await start({ seed });
  let other;
  try {
    other = await secondServer(app.db);
    const [{ value }] = (await app.context.cookies()).map(c => ({ value: c.value }));
    const create = (server, port, started) =>
      fetch(`${server}/api/trpc/worklogs.create`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `ikl_session_${port}=${value}` },
        body: JSON.stringify({ json: { issueKey: "acme/web#1", connectionId: github, seconds: 1800, started, comment: "" } }),
      }).then(r => r.status);
    const appPort = new URL(app.base).port;
    for (let round = 0; round < 6; round++) {
      const day = new Date(Date.now() - (round + 2) * 86_400_000);
      day.setHours(10, 0, 0, 0);
      const statuses = await Promise.all([create(app.base, appPort, day.toISOString()), create(other.base, other.port, new Date(day.getTime() + 600_000).toISOString())]);
      assert.deepEqual(statuses.sort(), [200, 409], `round ${round}: ${statuses}`);
      const rows = await app.db.q("SELECT count(*)::int AS n FROM worklogs WHERE started >= ? AND started < ?", day.getTime(), day.getTime() + 86_400_000 / 2);
      assert.deepEqual(rows, [{ n: 1 }], `round ${round}: one worklog`);
    }
    assert.deepEqual(await app.db.q("SELECT count(*)::int AS n FROM write_leases"), [{ n: 0 }]);
  } finally {
    await other?.stop();
    await app.stop();
  }
});
