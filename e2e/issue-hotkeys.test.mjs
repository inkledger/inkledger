// The issue page's hotkeys (now from the issue body shared with a desk's panes): "c" copies the
// key, "l" opens Log time, and one key press is answered once (one listener on the page).
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

test("issue page: C copies the key once, L opens one Log time dialog", () =>
  withApp({}, async ({ page, base }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.goto(`${base}/issues/DEMO-101`);
    await page.getByRole("heading", { name: /Test task number 1/ }).first().waitFor();
    await page.getByRole("button", { name: "Log time" }).waitFor();

    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.keyboard.press("c");
    await page.getByText("Key copied").first().waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "DEMO-101");
    // Two listeners would copy twice: two toasts.
    await page.waitForTimeout(300);
    assert.equal(await page.getByText("Key copied").count(), 1, "one copy for one key press");

    await page.keyboard.press("l");
    const dialog = page.getByRole("dialog");
    await dialog.first().waitFor();
    await page.waitForTimeout(300);
    assert.equal(await dialog.count(), 1, "one Log time dialog");
    await assert.doesNotReject(dialog.getByText("DEMO-101").first().waitFor({ timeout: 5000 }), "for this issue");

    // Esc closes it, and the page answers the key again.
    await page.keyboard.press("Escape");
    await dialog.first().waitFor({ state: "detached" });
    await page.keyboard.press("l");
    await dialog.first().waitFor();
    assert.equal(await dialog.count(), 1, "one Log time dialog again");
  }));
