// Accounts in the browser: a new server's first sign-in, and an invite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, withApp } from "./harness.mjs";

test("first start: the admin signs in with the default password, must change it, then invites someone who sets their own", () =>
  withApp({ bare: true }, async ({ page, base, context }) => {
    await page.goto(base + "/");
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill("admin");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Nothing else opens until the password is changed.
    await page.getByRole("heading", { name: "Choose a new password" }).waitFor();
    await page.goto(base + "/settings/users");
    await page.getByRole("heading", { name: "Choose a new password" }).waitFor();
    await page.getByLabel("Current password").fill("admin");
    await page.getByLabel("New password").fill("the admin's own password");
    await page.getByRole("button", { name: "Save password" }).click();
    await page.getByRole("heading", { name: "Choose a new password" }).waitFor({ state: "detached" });

    // In: Settings → Users invites Giulia.
    await page.goto(base + "/settings/users");
    await page.getByRole("button", { name: "Invite someone" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("Giulia");
    await dialog.getByLabel("Username").fill("giulia");
    await dialog.getByRole("button", { name: "Create and get link" }).click();
    const link = await page.getByRole("textbox", { name: "Invite link for Giulia" }).inputValue();
    assert.match(link, /\/invite\/[\w-]+$/);

    // Giulia, on her own device, opens the link and sets her password.
    const hers = await context.browser().newContext({ locale: "en-US" });
    try {
      const other = await hers.newPage();
      await other.goto(link);
      await other.getByRole("heading", { name: "Welcome, Giulia" }).waitFor();
      await other.getByLabel("Password").fill("giulia's own password");
      await other.getByRole("button", { name: "Set password and sign in" }).click();
      await other.waitForURL(url => new URL(url).pathname === "/");
      // A member: Users isn't hers to manage.
      await other.goto(base + "/settings/users");
      assert.equal(await other.getByRole("button", { name: "Invite someone" }).count(), 0);
      // The link worked once.
      const again = await hers.newPage();
      await again.goto(link);
      await again.getByText("This invite link has expired or was already used").waitFor();
    } finally {
      await hers.close();
    }
  }));
