// One key on two trackers (DEMO-101 on Jira and on GitHub): every write of time
// says which one, or the server can't tell them apart (it used to refuse with
// "on more than one tracker").
import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromMidnight, mockNative, start } from "./harness.mjs";

async function withApp(opts, body) {
  const app = await start(opts);
  try {
    await body(app);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
}

let github = 0;
/** DEMO-101 on GitHub too (which keeps no time: its entries stay in inkledger), with one entry at `started`. */
const sameKey = started => async db => {
  const now = Date.now();
  [{ id: github }] = await db.q(
    "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side projects', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
    now,
  );
  await db.q(
    `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
     VALUES (1, ?, 'I_9', 'DEMO-101', 'Same key on GitHub', 'Open', 'To Do', 'todo', 'acme/web', 'acme/web', 'Issue', '', '[]', '4242', 'https://github.com/acme/web/issues/9', ?)`,
    github, now,
  );
  await db.q(
    "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, ?, 'DEMO-101', 'local-same', ?, 60, 'first', 1)",
    github, started,
  );
};

function todayAt(h, m) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

const entries = db => db.q("SELECT connection_id, comment, time_spent_seconds FROM worklogs ORDER BY started, id");

// Its own timeout: near midnight it first waits up to 5 minutes (one day, start to end;
// the copy ends now and never starts before midnight).
test("the Timesheet edits, duplicates and deletes an entry on the tracker it is on", { timeout: 600_000 }, async () => {
  await awayFromMidnight();
  return withApp({ seed: sameKey(todayAt(9, 0) - 86_400_000) }, async ({ page, base, db }) => {
    // Yesterday's week (duplicating is for a day before today).
    const y = new Date(Date.now() - 86_400_000);
    const day = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
    await page.goto(base + "/timesheet");
    await page.getByRole("button", { name: "Pick a date" }).click();
    await page.getByLabel("Go to day").fill(day);
    await page.getByRole("button", { name: "Edit DEMO-101" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Comment").fill("edited");
    await dialog.getByRole("button", { name: "Update" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByText("Time entry updated").first().waitFor();
    assert.deepEqual(await entries(db), [{ connection_id: github, comment: "edited", time_spent_seconds: 60 }]);
    await page.getByRole("button", { name: /^Duplicate .* to today$/ }).first().click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Duplicate" }).click();
    await page.getByText("1 worklog duplicated to today").waitFor();
    const copied = await entries(db);
    assert.equal(copied.length, 2);
    assert.ok(copied.every(e => e.connection_id === github), "the copy is on GitHub too");
    await page.getByRole("button", { name: "Delete DEMO-101" }).first().click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await page.getByText("Worklog deleted").first().waitFor();
    assert.equal((await entries(db)).length, 1);
  });
});

test("an issue's page edits and deletes an entry on its own tracker", () =>
  withApp({ seed: sameKey(todayAt(0, 0) - 86_400_000) }, async ({ page, base, db }) => {
    await page.goto(`${base}/issues/${github}/I_9`);
    await page.getByRole("heading", { name: /Same key on GitHub/ }).first().waitFor();
    await page.getByRole("button", { name: "Edit worklog" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Comment").fill("edited");
    await dialog.getByRole("button", { name: "Update" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(await entries(db), [{ connection_id: github, comment: "edited", time_spent_seconds: 60 }]);
    await page.getByRole("button", { name: "Delete worklog" }).first().click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await page.getByText("Worklog deleted").first().waitFor();
    assert.deepEqual(await entries(db), []);
  }));

test("Log time from the issue list logs on the row's own tracker", () =>
  withApp({ seed: sameKey(todayAt(0, 0) - 2 * 86_400_000) }, async ({ page, base, db }) => {
    await page.goto(base + "/issues");
    const row = page.locator("tr").filter({ hasText: "Same key on GitHub" });
    await row.getByRole("button", { name: "Log time on DEMO-101" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("GitHub keeps no time").waitFor();
    await dialog.getByLabel("Time spent").fill("30m");
    const y = new Date(Date.now() - 86_400_000);
    const day = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
    await dialog.getByLabel("Start", { exact: true }).fill(`${day}T10:00`);
    await dialog.getByRole("button", { name: "Log", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const logged = (await entries(db)).filter(e => e.time_spent_seconds === 1800);
    assert.deepEqual(logged, [{ connection_id: github, comment: "", time_spent_seconds: 1800 }]);
  }));

test("focus mode shows the running timer's own issue and clock, not the same key's on another tracker", () =>
  withApp(
    {
      seed: async db => {
        await sameKey(todayAt(0, 0) - 3 * 86_400_000)(db);
        const now = Date.now();
        // Jira's DEMO-101: paused at 4 h. GitHub's DEMO-101: running, just started.
        await db.q(
          "INSERT INTO timers (user_id, connection_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 1, 'DEMO-101', 'paused', ?, 14400, ?, '', ?, ?)",
          now - 5 * 3600_000, now - 3600_000, now - 5 * 3600_000, now - 3600_000,
        );
        await db.q(
          "INSERT INTO timers (user_id, connection_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, ?, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
          github, now, now, now,
        );
      },
    },
    async ({ page, base }) => {
      await page.goto(base + "/issues");
      await page.getByRole("button", { name: "Focus mode (F)" }).first().click();
      const focus = page.getByRole("dialog");
      await focus.getByText("Same key on GitHub").waitFor();
      assert.equal(await focus.getByText("Test task number 1").count(), 0);
      const clock = await focus.locator(".font-display.tabular").first().textContent();
      assert.match(clock ?? "", /^0?0:0[0-4]:\d\d$/, `the running timer's few minutes, not the paused 4 h (${clock})`);
    },
  ));

test("the native menu bar names the running timer's own issue, not the same key's on another tracker", () =>
  withApp(
    {
      seed: async db => {
        await sameKey(todayAt(0, 0) - 3 * 86_400_000)(db);
        const now = Date.now();
        await db.q(
          "INSERT INTO timers (user_id, connection_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, ?, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
          github, now, now, now,
        );
      },
    },
    async ({ page, base, context }) => {
      await mockNative(context);
      await page.goto(base + "/issues");
      await page.waitForFunction(() => (window.__nativeCalls ?? []).some(c => c[0] === "set_tray_state" && c[1]?.timer?.summary));
      const tray = (await page.evaluate(() => window.__nativeCalls)).filter(c => c[0] === "set_tray_state" && c[1]?.timer).at(-1)[1].timer;
      assert.equal(tray.summary, "Same key on GitHub");
    },
  ));

test("deleting an entry another device has just removed counts as done, not as a failure", { timeout: 600_000 }, async () => {
  await awayFromMidnight();
  return withApp({ seed: sameKey(todayAt(9, 0) - 86_400_000) }, async ({ page, base, db }) => {
    const y = new Date(Date.now() - 86_400_000);
    const day = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
    await page.goto(base + "/timesheet");
    await page.getByRole("button", { name: "Pick a date" }).click();
    await page.getByLabel("Go to day").fill(day);
    await page.getByRole("button", { name: "Delete DEMO-101" }).first().waitFor();
    // Gone meanwhile (a sync, another device), still on screen here.
    await db.q("DELETE FROM worklogs");
    await page.getByRole("button", { name: "Delete DEMO-101" }).first().click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await page.getByText("Worklog deleted").first().waitFor();
    assert.equal(await page.getByText(/^Deleted \d+ of \d+/).count(), 0, "not reported as left");
  });
});

test("an entry whose tracker is archived is not deleted, and says so", { timeout: 600_000 }, async () => {
  await awayFromMidnight();
  return withApp({ seed: sameKey(todayAt(9, 0) - 86_400_000) }, async ({ page, base, db }) => {
    const y = new Date(Date.now() - 86_400_000);
    const day = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
    await db.q("UPDATE connections SET archived_at = ? WHERE id = ?", Date.now(), github);
    await page.goto(base + "/timesheet");
    await page.getByRole("button", { name: "Pick a date" }).click();
    await page.getByLabel("Go to day").fill(day);
    await page.getByRole("button", { name: "Delete DEMO-101" }).first().click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await page.getByText("Deleted 0 of 1: the one left is selected").first().waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM worklogs"))[0].n, 1, "still there");
  });
});

test("an issue's page reads its comments, attachments and history on its own tracker", () =>
  withApp(
    {
      seed: async db => {
        await sameKey(todayAt(0, 0) - 86_400_000)(db);
        await db.q("UPDATE issues SET jira_updated_at = ? WHERE connection_id = ?", Date.now() - 3_600_000, github);
      },
    },
    async ({ page, base }) => {
      // Every read about the issue, by procedure: the connection it names (a key alone is ambiguous here).
      const asked = [];
      page.on("request", r => {
        const u = new URL(r.url());
        if (!u.pathname.startsWith("/api/trpc/")) return;
        const procs = decodeURIComponent(u.pathname.slice("/api/trpc/".length)).split(",");
        const input = JSON.parse(u.searchParams.get("input") ?? "{}");
        procs.forEach((p, i) => asked.push({ p, connectionId: input[i]?.json?.connectionId }));
      });
      await page.goto(`${base}/issues/${github}/I_9`);
      await page.getByRole("heading", { name: /Same key on GitHub/ }).first().waitFor();
      await page.getByTitle("View history").first().click();
      await page.getByRole("dialog").waitFor();
      await page.waitForTimeout(500);
      for (const p of ["issues.comments", "issues.attachments", "issues.history"]) {
        const reads = asked.filter(a => a.p === p);
        assert.ok(reads.length > 0, `${p} read`);
        assert.deepEqual([...new Set(reads.map(a => a.connectionId))], [github], `${p} on its own tracker`);
      }
    },
  ));
