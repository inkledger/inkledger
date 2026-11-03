import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

// List-detail (docs/design-system.md §7.1): from a wide region the selected issue reads beside the list,
// by a click on its row or j / k; narrower, Space opens the same view over the list (Linear's Peek).
test("issues: the selected row reads beside the list on a wide screen", { timeout: 180_000 }, () =>
  withApp({ viewport: { width: 1440, height: 900 } }, async ({ page, base }) => {
    await page.goto(base + "/issues");
    const preview = page.getByRole("complementary", { name: "Preview" });
    await preview.waitFor();
    await preview.getByText(/Choose an issue/).waitFor();
    // A click on the row (not on its links) chooses it.
    await page.locator("tr[data-issue-id]").filter({ hasText: "DEMO-102" }).locator("td").nth(3).click();
    await preview.getByRole("heading", { name: /Test task number 2/ }).first().waitFor();
    // j moves the selection, and the preview with it.
    await page.keyboard.press("j");
    await preview.getByRole("heading", { name: /Test task number 3/ }).first().waitFor();
  }));

test("issues: Space takes a quick look over the list on a narrower screen", { timeout: 180_000 }, () =>
  withApp({ viewport: { width: 1280, height: 800 } }, async ({ page, base }) => {
    await page.goto(base + "/issues");
    await page.locator("tr[data-issue-id]").first().waitFor();
    assert.equal(await page.getByRole("complementary", { name: "Preview" }).isVisible(), false, "no side pane at this width");
    await page.keyboard.press("j");
    await page.keyboard.press(" ");
    const peek = page.getByRole("dialog", { name: /^Quick look at / });
    await peek.waitFor();
    await peek.getByRole("heading").first().waitFor();
    await page.keyboard.press("Escape");
    await peek.waitFor({ state: "detached" });
  }));
