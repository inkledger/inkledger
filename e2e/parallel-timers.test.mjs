// Timers side by side: Play while one runs asks to switch or run both (Enter repeats the last
// answer, off while overlapping time is refused); the running ones are rows in the sidebar; their
// time together is shared out at the log by a percentage, the next one defaulting to what is left,
// each placed where it ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayKey, lastWorkday, startTimer, withApp } from "./harness.mjs";

const quiet = db => db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
const runningKeys = async db => (await db.q("SELECT issue_key FROM timers WHERE state = 'running' ORDER BY issue_key")).map(r => r.issue_key);

test("Play while a timer runs: Run both keeps it running, the two are rows in the sidebar; Enter repeats the answer; Switch only while overlap is refused", () =>
  withApp({ viewport: { width: 1400, height: 900 }, seed: quiet }, async ({ page, base, db }) => {
    await page.goto(`${base}/issues`);
    await startTimer(page, "DEMO-101");

    await page.getByRole("button", { name: "Start timer DEMO-102" }).first().click();
    const ask = page.getByRole("alertdialog", { name: /^Running: DEMO-101 · / });
    await ask.getByText("Start DEMO-102?").waitFor();
    await ask.getByRole("button", { name: "Run both" }).click();
    await page.getByRole("button", { name: "Pause timer DEMO-102" }).first().waitFor();
    assert.deepEqual(await runningKeys(db), ["DEMO-101", "DEMO-102"]);
    // The one started last leads the sidebar's card; the other is a row below it, with its own pause and stop.
    const also = page.getByRole("list", { name: "Also running" });
    await also.getByText("DEMO-101").waitFor();
    await also.getByRole("button", { name: "Pause timer DEMO-101" }).waitFor();

    // The answer is remembered on this device: Enter runs the third beside them.
    await page.reload();
    await page.getByRole("button", { name: "Start timer DEMO-103" }).first().click();
    const again = page.getByRole("alertdialog", { name: /^Running: / });
    await again.getByRole("button", { name: "Run all" }).waitFor();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Pause timer DEMO-103" }).first().waitFor();
    assert.deepEqual(await runningKeys(db), ["DEMO-101", "DEMO-102", "DEMO-103"]);

    // Overlapping time refused: only Switch, said why; it stops the others.
    await db.q("UPDATE settings SET overlap_policy = 'block' WHERE user_id = 1");
    await page.reload();
    await page.getByRole("button", { name: "Start timer DEMO-104" }).first().click();
    const blocked = page.getByRole("alertdialog", { name: /^Running: / });
    await blocked.getByText(/Overlapping time is off/).waitFor();
    assert.equal(await blocked.getByRole("button", { name: "Run all" }).isDisabled(), true);
    await blocked.getByRole("button", { name: "Switch" }).click();
    // The three it stopped ask to be logged, one after the other: later.
    for (let i = 0; i < 3; i++) {
      // Each by its own name: the next one opens as soon as one closes.
      const title = await page.getByRole("dialog", { name: /^Log time on DEMO-10[123]$/ }).getByRole("heading").first().innerText();
      const log = page.getByRole("dialog", { name: title });
      await log.getByRole("button", { name: "Later" }).click();
      await log.waitFor({ state: "detached" });
    }
    await page.getByRole("button", { name: "Pause timer DEMO-104" }).first().waitFor();
    assert.deepEqual(await runningKeys(db), ["DEMO-104"]);
  }));

test("A logs 60 % of the 40 min it ran with B, placed where it ran; B is offered the 40 % left, after A's part", () => {
  const day = lastWorkday();
  const at = (h, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
  return withApp(
    {
      viewport: { width: 1400, height: 900 },
      // GitHub keeps no time: the entries stay in inkledger (nothing is sent anywhere, read-only or not).
      seed: async db => {
        await quiet(db);
        const now = Date.now();
        const [{ id: github }] = await db.q(
          "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side projects', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
          now,
        );
        for (const [n, title] of [[1, "Login fails on Safari"], [2, "Billing export is slow"]])
          await db.q(
            `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
             VALUES (1, ?, ?, ?, ?, 'Open', 'To Do', 'todo', 'acme/web', 'acme/web', 'Issue', '', '[]', '4242', ?, ?)`,
            github, `I_${n}`, `acme/web#${n}`, title, `https://github.com/acme/web/issues/${n}`, now,
          );
        const timer = (key, seconds, startedAt, pausedAt) =>
          db.q(
            "INSERT INTO timers (user_id, connection_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, ?, ?, 'paused', ?, ?, ?, '', ?, ?)",
            github, key, startedAt, seconds, pausedAt, pausedAt, pausedAt,
          );
        // A ran 9:00–11:00, B 10:20–11:30.
        await timer("acme/web#1", 7200, at(9), at(11));
        await timer("acme/web#2", 4200, at(10, 20), at(11, 30));
        await db.q(
          "INSERT INTO timer_runs (user_id, connection_id, issue_key, started_at, ended_at) VALUES (1, ?, 'acme/web#1', ?, ?), (1, ?, 'acme/web#2', ?, ?)",
          github, at(9), at(11), github, at(10, 20), at(11, 30),
        );
      },
    },
    async ({ page, base, db }) => {
      await page.goto(`${base}/?period=day&from=${dayKey(day)}`);
      await page.getByRole("button", { name: /^acme\/web#1, .* tracked and not logged yet: log it$/ }).first().click();
      const a = page.getByRole("dialog", { name: "Log time on acme/web#1" });
      const share = a.getByLabel(/^Your share of the 40 min with acme\/web#2/);
      assert.equal(await share.inputValue(), "50");
      await a.getByText("1 h 20 min").waitFor();
      await share.fill("60");
      await a.getByText("→ 24 min").waitFor();
      assert.equal(await a.getByLabel(/^Time spent/).inputValue(), "1h 44m");
      await a.getByRole("button", { name: "Log", exact: true }).click();
      await a.waitFor({ state: "detached" });
      const [logA] = await db.q("SELECT started, time_spent_seconds FROM worklogs WHERE issue_key = 'acme/web#1'");
      assert.deepEqual([Number(logA.started), logA.time_spent_seconds], [at(9), 104 * 60]);

      await page.getByRole("button", { name: /^acme\/web#2, .* tracked and not logged yet: log it$/ }).first().click();
      const b = page.getByRole("dialog", { name: "Log time on acme/web#2" });
      assert.equal(await b.getByLabel(/^Your share of the 40 min with acme\/web#1/).inputValue(), "40");
      assert.equal(await b.getByLabel(/^Time spent/).inputValue(), "46m");
      await b.getByRole("button", { name: "Log", exact: true }).click();
      await b.waitFor({ state: "detached" });
      const [logB] = await db.q("SELECT started, time_spent_seconds FROM worklogs WHERE issue_key = 'acme/web#2'");
      // Tiled: the two worklogs fill 9:00–11:30 once, never over each other.
      assert.deepEqual([Number(logB.started), logB.time_spent_seconds], [at(10, 44), 46 * 60]);
      assert.equal((await db.q("SELECT count(*)::int AS n FROM timers"))[0].n, 0);
    },
  );
});
