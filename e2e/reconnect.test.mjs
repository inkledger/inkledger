// A tracker that refuses the saved credentials: the user stays in, a bar asks to reconnect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, trpcProcs, withApp } from "./harness.mjs";

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

test("a tracker out of reach too many times: background sync paused, Retry runs the user's own sync", () =>
  withApp({ seed: db => db.q("UPDATE connections SET status = 'unreachable'") }, async ({ page, base }) => {
    await page.goto(base + "/");
    const bar = page.getByRole("status").filter({ hasText: "background sync is paused" });
    await bar.waitFor();
    assert.match(await bar.innerText(), /Jira \(jira\.example\.it\) hasn't answered for 3 attempts/);
    assert.equal(await bar.getByRole("link", { name: "Reconnect" }).count(), 0);
    const synced = page.waitForResponse(r => r.url().includes("/api/trpc/") && trpcProcs(r.url()).includes("issues.sync"));
    await bar.getByRole("button", { name: "Retry" }).click();
    await synced;
    // The test Jira is still out of reach: said, and the bar stays (a pass that goes through makes it "ok": api/sync/state.test.ts).
    await page.getByText(/^Sync failed:/).waitFor();
    await page.waitForTimeout(500);
    assert.equal(await bar.count(), 1);
  }));
