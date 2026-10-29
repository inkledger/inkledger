// A tracker that refuses the saved credentials: the user stays in, a bar asks to reconnect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, withApp } from "./harness.mjs";

test("refused credentials: still signed in, a bar leads to reconnecting the tracker", () =>
  withApp({ seed: db => db.q("UPDATE connections SET status = 'auth_failed'") }, async ({ page, base }) => {
    await page.goto(base + "/");
    const bar = page.getByRole("status").filter({ hasText: "no longer accepts the saved credentials" });
    await bar.waitFor();
    assert.match(await bar.innerText(), /Jira \(jira\.example\.it\)/);
    await bar.getByRole("link", { name: "Reconnect" }).click();
    await page.waitForURL(u => u.pathname === "/settings/connections");
    await page.getByRole("dialog").getByRole("heading", { name: "Reconnect jira.example.it" }).waitFor();
    // Closing the form leaves the address clean.
    await page.keyboard.press("Escape");
    await page.waitForURL(u => !u.searchParams.has("reconnect"));
  }));
