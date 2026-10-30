// Copies of pinned mails (docs/work/ideas/mail-copies.md): consent, the copy kept with the pin,
// the viewer that loads nothing from outside, and the pages at 320 px.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

/** Settings → Outlook: signed in to the simulated mailbox, then copies on (consent asked once). */
async function copiesOn(page, base, mode = "Text and layout") {
  await page.goto(base + "/settings/outlook");
  const popup = page.context().waitForEvent("page").catch(() => null);
  await page.getByRole("button", { name: "Sign in to Microsoft" }).click();
  await page.getByTestId("mail-user-code").waitFor();
  await (await popup)?.close();
  await page.getByText("Signed in as Mario Rossi").waitFor({ timeout: 15_000 });
  const group = page.locator("#outlook-copies");
  await group.getByRole("radio", { name: mode }).click();
  const consent = page.getByRole("dialog", { name: "Keep copies of the mails you pin?" });
  await consent.getByRole("button", { name: "Keep copies" }).click();
  await consent.waitFor({ state: "detached" });
  await group.getByRole("radio", { name: mode, checked: true }).waitFor();
}

/** "Budget 2027" from the mailbox, pinned to DEMO-102; then its issue page. */
async function pinBudget(page, base) {
  await page.goto(base + "/");
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("option", { name: "Pin a mail…" }).click();
  const dialog = page.getByRole("dialog", { name: "Pin a mail" });
  await dialog.getByRole("textbox", { name: "Search your mailbox" }).fill("budget");
  await dialog.getByRole("region", { name: "In your mailbox" }).getByRole("button", { name: /Budget 2027/ }).click();
  const where = page.getByRole("dialog", { name: "Where does it go?" });
  await where.getByRole("textbox", { name: "Search an issue (key or words)" }).fill("Test task number 2");
  await where.getByRole("button", { name: /DEMO-102/ }).click();
  await where.waitFor({ state: "detached" });
  await page.goto(base + "/issues/DEMO-102");
}

test("a pinned mail survives its deletion in Outlook", () =>
  withApp({ env: { MAIL_SIMULATOR: "1" } }, async ({ page, base, db }) => {
    await copiesOn(page, base);
    assert.equal((await db.q("SELECT mail_copies FROM settings WHERE user_id = 1"))[0].mail_copies, "body");
    await pinBudget(page, base);
    // The card says the copy is kept; its menu opens it.
    await page.getByText("Copy saved").waitFor();
    await page.getByRole("button", { name: "Copy of Budget 2027" }).click();
    await page.getByRole("menuitem", { name: "Open the copy" }).click();
    const viewer = page.getByRole("dialog", { name: "Budget 2027" });
    const frame = viewer.frameLocator("iframe");
    await frame.getByText("Hello Mario, about").waitFor();
    await viewer.getByText("Attachments are not kept").waitFor();
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    // Deleted in Outlook (the simulated mailbox no longer has it): "Is it still there?" says so.
    await db.q("UPDATE mails SET internet_message_id = 'deleted-in-outlook@example.com'");
    await page.getByRole("button", { name: "Copy of Budget 2027" }).click();
    await page.getByRole("menuitem", { name: "Is it still there?" }).click();
    await page.getByText("Deleted in Outlook").first().waitFor();
    assert.equal((await db.q("SELECT gone_at IS NOT NULL AS gone FROM mails"))[0].gone, true);
    // Now its subject opens the copy, not Outlook.
    await page.getByRole("button", { name: "Budget 2027", exact: true }).click();
    await viewer.frameLocator("iframe").getByText("Hello Mario, about").waitFor();
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    // Deleted: the pin stays, without a copy.
    await page.getByRole("button", { name: "Copy of Budget 2027" }).click();
    await page.getByRole("menuitem", { name: "Delete the copy" }).click();
    await page.getByText("Copy deleted").waitFor();
    await page.getByText("Copy saved").waitFor({ state: "detached" });
    assert.deepEqual(await db.q("SELECT count(*)::int AS n FROM mail_copies"), [{ n: 0 }]);
    assert.deepEqual(await db.q("SELECT count(*)::int AS n FROM mail_links"), [{ n: 1 }]);
  }));

test("a saved mail shows without loading remote images", () =>
  withApp({ env: { MAIL_SIMULATOR: "1" } }, async ({ page, base }) => {
    await copiesOn(page, base, "Everything, with attachments");
    await pinBudget(page, base);
    // What actually went out: the browser reports a request the CSP stopped too (failure "csp").
    const outside = [];
    const toTracker = r => new URL(r.url()).hostname.endsWith("tracker.example.net");
    page.on("requestfinished", r => toTracker(r) && outside.push(r.url()));
    page.on("requestfailed", r => toTracker(r) && r.failure()?.errorText !== "csp" && outside.push(r.url()));
    await page.getByRole("button", { name: "Copy of Budget 2027" }).click();
    await page.getByRole("menuitem", { name: "Open the copy" }).click();
    const viewer = page.getByRole("dialog", { name: "Budget 2027" });
    await viewer.frameLocator("iframe").getByText("Hello Mario, about").waitFor();
    // The mail's image (a tracking pixel would be one) is in its HTML, and never asked for.
    assert.equal(await viewer.frameLocator("iframe").locator('img[src="https://tracker.example.net/pixel.gif"]').count(), 1);
    await page.waitForTimeout(500);
    assert.deepEqual(outside, []);
    // Full copies list their attachments as downloads.
    await viewer.getByRole("link", { name: "notes.bin" }).waitFor();
  }));

test("copies at 320 px", () =>
  withApp({ env: { MAIL_SIMULATOR: "1" }, viewport: { width: 320, height: 720 } }, async ({ page, base }) => {
    await copiesOn(page, base, "Everything, with attachments");
    await pinBudget(page, base);
    await page.getByText("Copy saved").waitFor();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.goto(base + "/settings/outlook");
      await page.locator("#outlook-copies").getByRole("button", { name: "Delete all copies" }).waitFor();
      assert.equal(await overflow(), 0, `settings in ${scheme}`);
      await page.goto(base + "/issues/DEMO-102");
      await page.getByRole("button", { name: "Copy of Budget 2027" }).click();
      await page.getByRole("menuitem", { name: "Open the copy" }).click();
      const viewer = page.getByRole("dialog", { name: "Budget 2027" });
      await viewer.frameLocator("iframe").getByText("Hello Mario, about").waitFor();
      assert.equal(await overflow(), 0, `viewer in ${scheme}`);
      const box = await viewer.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 320, `the viewer fits in ${scheme}: ${JSON.stringify(box)}`);
      await page.keyboard.press("Escape");
    }
  }));
