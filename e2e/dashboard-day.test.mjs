// Stepping from one day to the next on the Dashboard: the last day stays on
// screen, faded, until the new one's worklogs come. Its holes must not be
// offered meanwhile: computed against the other day's entries, logging into
// one would overlap time the new day already has. (Today the day's worklogs
// and its week's status travel in one batch, so none shows: this pins it.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromMidnight, start } from "./harness.mjs";

/** Monday of last week, as the Dashboard's `from`: past, and the next day in the same week. */
function lastMonday() {
  const d = new Date();
  d.setDate(d.getDate() - 7 - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
    await page.locator('section[aria-busy="true"]').waitFor();
    assert.equal(await holes.and(page.locator(":enabled")).count(), 0, "no hole offered on the faded day");
    holding = false;
    release();
    await page.locator('section[aria-busy="true"]').waitFor({ state: "detached" });
    await holes.and(page.locator(":enabled")).first().waitFor();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  } finally {
    await app.stop();
  }
});

// "Later" after a stop: the time stays tracked on a paused timer. It used to vanish
// from the day's timeline (only a running timer was drawn) and what was typed was lost.
test("a stopped timer left for later stays on the timeline, keeps what was typed, and logs from there", { timeout: 600_000 }, async () => {
  // Today's timeline, so not across midnight; the timer ran the last 40 minutes.
  await awayFromMidnight(5 * 60_000, 45 * 60_000);
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
    // Its tracked time comes back with it (40 minutes, rounded to the minute).
    assert.match(await again.getByLabel(/^Time spent/).inputValue(), /40m/);
    await again.getByRole("button", { name: "Later" }).click();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM worklogs"))[0].n, 0, "nothing logged by Later");
  } finally {
    await app.stop();
  }
});

test("on a phone a stopped timer to log is a row big enough to tap", { timeout: 600_000 }, async () => {
  await awayFromMidnight(5 * 60_000, 70 * 60_000);
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
