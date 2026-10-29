// Estimates (docs/work/ideas/estimates.md): how long an issue likely takes on its page, the TODO's
// suggestion, the statuses that count as work in Settings, and all of it at 320 px, light and dark.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";
import { seed } from "./fixtures/estimates.mjs";

/** The "Likely" figure beside the issue's time */
const likely = page => page.locator("dl div").filter({ has: page.locator("dt", { hasText: /^Likely$/ }) }).locator("dd");

test("the issue page says how long it likely takes", () =>
  withApp({ seed }, async ({ page, base }) => {
    await page.goto(base + "/issues/EST-1");
    await likely(page).waitFor();
    // Six alike, 3 h 30 each: the range is that, its basis and how sure it is beside it.
    assert.match(await likely(page).innerText(), /^3 h 30 min – 3 h 30 min$/);
    const lines = page.getByTestId("issue-estimate");
    await lines.getByText("median 3 h 30 min · 6 similar issues · similar titles in this project").waitFor();
    await lines.getByText("rough", { exact: true }).waitFor();
    // The closed one never read is waiting, and said so.
    await lines.getByText("1 waiting for their history").waitFor();
    // A closed issue shows nothing.
    await page.goto(base + "/issues/EST-10");
    await page.getByRole("heading", { name: /Work on EST-10/ }).first().waitFor();
    assert.equal(await page.getByTestId("issue-estimate").count(), 0);
    assert.equal(await likely(page).count(), 0);
  }));

test("a TODO takes the suggested estimate in one click", () =>
  withApp({ seed }, async ({ page, base, db }) => {
    await page.goto(base + "/todos");
    const row = page.getByRole("listitem", { name: "Finish EST-1" });
    const suggestion = row.getByRole("button", { name: "Set the likely estimate, 3 h 30 min" });
    await suggestion.waitFor();
    assert.equal((await suggestion.innerText()).trim(), "~3 h 30 min");
    await suggestion.click();
    await suggestion.waitFor({ state: "detached" });
    let stored = null;
    for (let i = 0; i < 50 && stored !== 12600; i++) {
      [{ estimate_seconds: stored }] = await db.q("SELECT estimate_seconds FROM todos WHERE text = 'Finish EST-1'");
      if (stored !== 12600) await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(stored, 12600);
  }));

test("the statuses that count as work are chosen per connection", () =>
  withApp({ seed }, async ({ page, base, db }) => {
    await page.goto(base + "/settings/estimates");
    const waiting = page.getByRole("switch", { name: "Counts as work: Waiting for customer" });
    await waiting.waitFor();
    assert.equal(await waiting.getAttribute("aria-checked"), "true");
    await waiting.click();
    await page.waitForFunction(() => document.querySelector('[role=switch][aria-label="Counts as work: Waiting for customer"]')?.getAttribute("aria-checked") === "false");
    await page.getByRole("button", { name: "Back to default" }).waitFor();
    assert.deepEqual(await db.q("SELECT status_id, counts FROM work_statuses"), [{ status_id: "41", counts: 0 }]);
    // Only the 30 min in progress count now.
    await page.goto(base + "/issues/EST-1");
    await likely(page).waitFor();
    assert.match(await likely(page).innerText(), /^30 min – 30 min$/);
    // Back to the default: it counts again.
    await page.goto(base + "/settings/estimates");
    await page.getByRole("button", { name: "Back to default" }).click();
    await page.waitForFunction(() => document.querySelector('[role=switch][aria-label="Counts as work: Waiting for customer"]')?.getAttribute("aria-checked") === "true");
    assert.deepEqual(await db.q("SELECT status_id FROM work_statuses"), []);
  }));

// The accuracy part (batch 5); the forecast and the trend join it with batch 7.
test("Reports shows accuracy, forecast and trend", () =>
  withApp({ seed }, async ({ page, base }) => {
    await page.goto(base + "/reports");
    const accuracy = page.getByTestId("estimate-accuracy");
    await accuracy.waitFor();
    // Six alike issues: the first five have too little before them, the sixth is predicted exactly.
    await accuracy.getByText("100% within the range · typical error 0% · 1 issues").waitFor();
    await accuracy.getByText("5 without enough earlier history").waitFor();
    assert.equal(await page.getByRole("progressbar", { name: "Estimate accuracy" }).getAttribute("aria-valuenow"), "100");
  }));

test("estimates at 320 px", () =>
  withApp({ seed, viewport: { width: 320, height: 800 } }, async ({ page, base }) => {
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      for (const [route, ready] of [
        ["/issues/EST-1", () => page.getByTestId("issue-estimate").waitFor()],
        ["/settings/estimates", () => page.getByRole("switch", { name: "Counts as work: Waiting for customer" }).waitFor()],
        ["/reports", () => page.getByTestId("estimate-accuracy").waitFor()],
      ]) {
        await page.goto(base + route);
        await ready();
        const overflow = await page.evaluate(() => {
          const root = document.documentElement;
          const main = document.querySelector("main");
          return { root: root.scrollWidth - root.clientWidth, main: main ? main.scrollWidth - main.clientWidth : 0 };
        });
        assert.deepEqual(overflow, { root: 0, main: 0 }, `${route} in ${scheme}`);
      }
    }
  }));
