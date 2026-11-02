// Spec §21 E2E #5: two devices change the same layout; the later one is told, keeps what nobody else
// touched, and nothing is decided by whoever writes last.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

async function waitUntil(check, what) {
  for (let i = 0; i < 80; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("Two devices on one layout: the phone is told of the desktop's change and keeps only its own, by choice", () =>
  withApp({ viewport: { width: 1280, height: 1400 } }, async ({ page, base, db, context }) => {
    // A second device: its own browser, cookies and tab identity, a phone's screen.
    const phoneContext = await context.browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/Rome", locale: "en-US" });
    await phoneContext.addCookies(await context.cookies());
    const phone = await phoneContext.newPage();
    const revisions = async () => (await db.q("SELECT count(*)::int AS n FROM workspace_revisions"))[0].n;
    try {
      await page.goto(`${base}/settings/workspace`);
      await phone.goto(`${base}/settings/workspace`);
      await phone.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: /^Show / }).waitFor();

      await page.locator('[data-anchor="dashboard.stats"]').getByRole("button", { name: /^Show / }).click();
      await page.getByText(/Preview, not applied yet/).waitFor();
      await page.getByRole("button", { name: "Apply layout" }).click();
      await waitUntil(async () => (await revisions()) === 1, "the desktop's change to apply");

      // The phone still shows the layout from before: its change to the same block is refused, then an unrelated one.
      await phone.locator('[data-anchor="dashboard.stats"]').getByRole("button", { name: /^Pin / }).click();
      await phone.getByRole("alert").filter({ hasText: "The layout changed meanwhile" }).waitFor();
      assert.equal(await revisions(), 1, "the later write did not win");
      await phone.locator('[data-anchor="dashboard.activity"]').getByRole("button", { name: /^Show / }).click();
      await phone.getByRole("alert").getByRole("button", { name: "Keep my other change (1)" }).click();
      await phone.getByText(/Preview, not applied yet/).waitFor();
      assert.equal(await revisions(), 1, "kept as a preview only");
      await phone.getByRole("button", { name: "Apply layout" }).click();
      await waitUntil(async () => (await revisions()) === 2, "the phone's own change to apply");

      const [live] = await db.q("SELECT operations FROM workspace_revisions WHERE status = 'committed'");
      const visibility = Object.fromEntries(JSON.parse(live.operations).map(item => item.operation).filter(operation => operation.type === "visibility").map(operation => [operation.anchorId, operation.visible]));
      assert.deepEqual(visibility, { "dashboard.stats": false, "dashboard.activity": false }, "both devices' choices, neither overwritten");
      const pins = JSON.parse(live.operations).filter(item => item.operation.type === "pin");
      assert.equal(pins.length, 0, "the refused change was not slipped in");
    } finally {
      await phoneContext.close();
    }
  }));
