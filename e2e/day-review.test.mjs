// Close the day: a running timer keeps counting while the sheet is open; the
// confirmation snapshots its live length, and that snapshot stands for the
// whole save, the sheet's summary included (not the length it had when the
// sheet opened).
import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromMidnight, start } from "./harness.mjs";

// Its own timeout: near midnight it first waits up to 8 minutes (see below).
test("while the day is being logged, the summary shows what is being logged", { timeout: 600_000 }, async () => {
  // The block must fit today (it never starts before midnight), and the test must not
  // cross midnight: just after it, minutes instead of half hours, and those few minutes.
  await awayFromMidnight(2 * 60_000, 6 * 60_000);
  const midnight = new Date().setHours(0, 0, 0, 0);
  const early = Date.now() - midnight < 55 * 60_000;
  const [first, extra] = early ? [3, 2] : [30, 20];
  const now = Date.now();
  const app = await start({
    seed: async db => {
      await db.q(
        "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
        now - first * 60_000, now, now,
      );
      // No "you were away" question while the test waits.
      await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
    },
  });
  try {
    const { page, base } = app;
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Close the day" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Close the day" });
    await sheet.waitFor();
    // The timer runs on while the sheet is open: more minutes on the server, read by the next poll.
    await app.db.q("UPDATE timers SET started_at = started_at - ? WHERE issue_key = 'DEMO-101'", extra * 60_000);
    // The next poll asked after that change (5–15 s), and its answer.
    const asked = await page.waitForRequest(r => new URL(r.url()).pathname.includes("timers.list"), { timeout: 30_000 });
    await (await asked.response())?.finished();
    await page.waitForTimeout(300);
    await sheet.getByRole("button", { name: /^Log 1 to / }).click();
    const confirm = page.getByRole("alertdialog");
    await confirm.waitFor();
    const logged = (await confirm.locator("li .tabular").first().innerText()).trim();
    // The live length, not the one the sheet opened with: otherwise this proves nothing.
    assert.equal(logged, `${first + extra} min`);
    // The save held on its way to the server.
    let release = () => {};
    const held = new Promise(r => (release = r));
    await page.route(u => new URL(u).pathname.startsWith("/api/trpc/") && new URL(u).pathname.includes("worklogs.create"), async route => {
      await held;
      return route.continue();
    });
    await confirm.getByRole("button", { name: "Log", exact: true }).click();
    await page.waitForTimeout(400);
    const summary = await sheet.locator("footer, [class*=border-t]").last().innerText().catch(() => sheet.innerText());
    assert.ok(summary.includes(`${logged} in 1 entry`), `the summary shows ${logged}: ${summary}`);
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  } finally {
    await app.stop();
  }
});

test("the day is never logged on guesses: while today's worklogs can't be read, Log waits, says why, and retries", async () => {
  const now = Date.now();
  const app = await start({
    seed: async db => {
      await db.q(
        "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'paused', ?, 1800, ?, '', ?, ?)",
        now - 3_600_000, now - 1_800_000, now, now,
      );
      await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
    },
  });
  try {
    const { page, base } = app;
    // Today's worklogs: no answer the page can use (the server fails), until the test lets them through.
    let failing = true;
    const creates = [];
    await page.route(u => new URL(u).pathname.startsWith("/api/trpc/"), async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.includes("worklogs.create")) creates.push(path);
      if (failing && path.includes("worklogs.list")) return route.fulfill({ status: 500, contentType: "application/json", body: "[]" });
      return route.continue();
    });
    // The explicit date keeps this on the SPA: the route failure is a client-side one,
    // not a successful prefetch in the SSR document for today's plain URL.
    await page.goto(base + "/?from=" + new Date().toLocaleDateString("en-CA"));
    await page.getByRole("button", { name: "Close the day" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Close the day" });
    await sheet.waitFor();
    await sheet.getByRole("alert").getByText("Today's time couldn't be read").waitFor();
    const log = sheet.getByRole("button", { name: /^Log 1 to / });
    assert.equal(await log.isDisabled(), true, "Log waits for today's worklogs");
    failing = false;
    await sheet.getByRole("alert").getByRole("button", { name: "Retry" }).click();
    await sheet.getByRole("alert").waitFor({ state: "detached" });
    // Enabled once everything the placement needs is read (the timers may land a moment later).
    await log.and(page.locator(":enabled")).waitFor({ timeout: 10_000 });
    assert.deepEqual(creates, [], "nothing was logged meanwhile");
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});

test("a timer stopped on an earlier day isn't preselected to log today", async () => {
  const now = Date.now();
  const yesterday = new Date(now - 86_400_000).setHours(17, 0, 0, 0);
  const app = await start({
    seed: async db => {
      await db.q(
        "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'paused', ?, 3600, ?, '', ?, ?)",
        yesterday - 3_600_000, yesterday, now, now,
      );
      await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
    },
  });
  try {
    const { page, base } = app;
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Close the day" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Close the day" });
    await sheet.waitFor();
    const row = sheet.getByRole("checkbox").first();
    await row.waitFor();
    assert.equal(await row.getAttribute("data-state"), "unchecked");
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});

test("Close the day: edited durations ask before Escape throws them away", async () => {
  const now = Date.now();
  const app = await start({
    seed: async db => {
      await db.q(
        "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'paused', ?, 1800, ?, '', ?, ?)",
        now - 3_600_000, now - 1_800_000, now, now,
      );
      await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
    },
  });
  try {
    const { page, base } = app;
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Close the day" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Close the day" });
    await sheet.waitFor();
    const duration = sheet.getByRole("textbox").first();
    await duration.fill("45m");
    await page.keyboard.press("Escape");
    const ask = page.getByRole("alertdialog");
    await ask.waitFor();
    await ask.getByRole("button", { name: "Keep editing" }).click();
    assert.equal(await duration.inputValue(), "45m", "kept");
    await page.keyboard.press("Escape");
    await page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
    await sheet.waitFor({ state: "detached" });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
