// Stepping from one day to the next on the Dashboard: the last day stays on
// screen, faded, until the new one's worklogs come. Its holes must not be
// offered meanwhile: computed against the other day's entries, logging into
// one would overlap time the new day already has. (Today the day's worklogs
// and its week's status travel in one batch, so none shows: this pins it.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayKey, nearMidnight, start, withApp } from "./harness.mjs";

/** Monday of last week, as the Dashboard's `from`: past, and the next day in the same week. */
function lastMonday() {
  const d = new Date();
  d.setDate(d.getDate() - 7 - ((d.getDay() + 6) % 7));
  return dayKey(d);
}

test("while the next day's worklogs are on their way, the last day's holes can't be acted on", async () => {
  const app = await start();
  try {
    const { page, base } = app;
    await page.goto(`${base}/?period=day&from=${lastMonday()}`);
    const holes = page.getByRole("button", { name: /^Log missing time from/ });
    await holes.first().waitFor();
    // The next day's worklogs held back.
    let release = () => {};
    const held = new Promise(r => (release = r));
    let holding = true;
    await page.route(u => new URL(u).pathname.startsWith("/api/trpc/") && new URL(u).pathname.includes("worklogs.list"), async route => {
      if (holding) await held;
      return route.continue();
    });
    await page.getByRole("button", { name: "Next period" }).click();
    const fadedDay = page.locator('section[data-workspace-anchor="dashboard.timeline"][aria-busy="true"]');
    await fadedDay.waitFor();
    assert.equal(await holes.and(page.locator(":enabled")).count(), 0, "no hole offered on the faded day");
    holding = false;
    release();
    await fadedDay.waitFor({ state: "detached" });
    await holes.and(page.locator(":enabled")).first().waitFor();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  } finally {
    await app.stop();
  }
});

// "Later" after a stop: the time stays tracked on a paused timer. It used to vanish
// from the day's timeline (only a running timer was drawn) and what was typed was lost.
test("a stopped timer left for later stays on the timeline, keeps what was typed, and logs from there", { skip: nearMidnight(5 * 60_000, 45 * 60_000), timeout: 600_000 }, async () => {
  // Today's timeline, so not across midnight; the timer ran the last 40 minutes.
  const now = Date.now();
  const app = await start({
    seed: async db => {
      await db.q(
        "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
        now - 40 * 60_000, now, now,
      );
      await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
    },
  });
  try {
    const { page, base, db } = app;
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Stop and log time on DEMO-101" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Log time on DEMO-101" });
    await dialog.getByLabel("Comment").fill("half of the import done");
    await dialog.getByRole("button", { name: "Later" }).click();
    await dialog.waitFor({ state: "detached" });

    const block = page.getByRole("button", { name: /^DEMO-101, .* tracked and not logged yet: log it$/ }).first();
    await block.waitFor();
    for (let i = 0; i < 50; i++) {
      const [row] = await db.q("SELECT state, note FROM timers WHERE issue_key = 'DEMO-101'");
      if (row?.note) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const [row] = await db.q("SELECT state, note FROM timers WHERE issue_key = 'DEMO-101'");
    assert.deepEqual(row, { state: "paused", note: "half of the import done" }, "the typed comment stays as the timer's note");

    await block.click();
    const again = page.getByRole("dialog", { name: "Log time on DEMO-101" });
    assert.equal(await again.getByLabel("Comment").inputValue(), "half of the import done");
    // Its tracked time comes back with it, rounded to the minute: about 40 minutes, but a slow runner
    // can reach 40m30s before the stop, so the expected value is what the paused timer kept.
    const [{ secs }] = await db.q("SELECT accumulated_seconds AS secs FROM timers WHERE issue_key = 'DEMO-101'");
    assert.ok(secs >= 40 * 60 && secs < 45 * 60, `tracked ${secs}s`);
    // The block keeps sub-second time the column doesn't, so near the half minute it may round either way.
    const shown = await again.getByLabel(/^Time spent/).inputValue();
    assert.ok([Math.floor(secs / 60), Math.ceil(secs / 60)].map(m => `${m}m`).includes(shown), `shown ${shown} for ${secs}s`);
    await again.getByRole("button", { name: "Later" }).click();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM worklogs"))[0].n, 0, "nothing logged by Later");
  } finally {
    await app.stop();
  }
});

test("on a phone a stopped timer to log is a row big enough to tap", { skip: nearMidnight(5 * 60_000, 70 * 60_000), timeout: 600_000 }, async () => {
  const now = Date.now();
  const app = await start({
    viewport: { width: 320, height: 760 },
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
    const list = page.getByRole("list", { name: "Stopped timers to log" });
    const row = list.getByRole("button", { name: /^DEMO-101, .* tracked and not logged yet: log it$/ });
    const box = await row.boundingBox();
    assert.ok(box && box.height >= 43, `tap target ${box?.height}`);
    await row.click();
    await page.getByRole("dialog", { name: "Log time on DEMO-101" }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `horizontal overflow: ${overflow}`);
  } finally {
    await app.stop();
  }
});

test("My issues on a phone: two cards a column, then Show all to the Board", { timeout: 180_000 }, () =>
  withApp({ viewport: { width: 390, height: 844 } }, async ({ page, base }) => {
    await page.goto(base + "/");
    const tasks = page.locator('[data-workspace-anchor="dashboard.tasks"]');
    await tasks.locator("li").first().waitFor();
    const shown = await tasks.locator("ul[aria-label]").evaluateAll(lists => lists.map(l => [...l.children].filter(li => li.offsetParent !== null).length));
    assert.ok(shown.length > 0 && shown.every(n => n <= 2), `at most two a column (${shown})`);
    const total = await tasks.locator("ul[aria-label] > li").count();
    if (total > shown.reduce((a, b) => a + b, 0)) assert.ok(await tasks.getByRole("link", { name: /^Show all/ }).first().isVisible(), "the rest a click away");
  }));

// "Later" while the draft's last save is still on its way (a slow server): it used to read the draft
// before that save landed, and what was typed was lost. It waits for the save in flight now.
test("Later waits for a draft save still on its way: what was typed is kept", { skip: nearMidnight(5 * 60_000, 45 * 60_000), timeout: 600_000 }, async () => {
  const now = Date.now();
  const app = await start({
    seed: async db => {
      await db.q(
        "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
        now - 40 * 60_000, now, now,
      );
      await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
    },
  });
  try {
    const { page, base, db } = app;
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Stop and log time on DEMO-101" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Log time on DEMO-101" });
    await dialog.getByLabel("Comment").waitFor();
    // The draft's saves reach the server only after a while.
    let sent = () => {};
    const started = new Promise(r => (sent = r));
    await page.route(u => new URL(u).pathname.includes("decisions.patchDraft"), async route => {
      sent();
      await new Promise(r => setTimeout(r, 1500));
      await route.continue();
    });
    await dialog.getByLabel("Comment").fill("half of the import done");
    // Its save has left (the typing pause passed) and is still on its way: Later now.
    await started;
    await dialog.getByRole("button", { name: "Later" }).click();
    await dialog.waitFor({ state: "detached" });
    let row;
    for (let i = 0; i < 100; i++) {
      [row] = await db.q("SELECT state, note FROM timers WHERE issue_key = 'DEMO-101'");
      if (row?.note) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.deepEqual(row, { state: "paused", note: "half of the import done" }, "the typed comment stays as the timer's note");
    await page.unrouteAll({ behavior: "ignoreErrors" });
  } finally {
    await app.stop();
  }
});
