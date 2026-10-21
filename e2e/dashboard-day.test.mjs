// Stepping from one day to the next on the Dashboard: the last day stays on
// screen, faded, until the new one's worklogs come. Its holes must not be
// offered meanwhile: computed against the other day's entries, logging into
// one would overlap time the new day already has. (Today the day's worklogs
// and its week's status travel in one batch, so none shows: this pins it.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

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
