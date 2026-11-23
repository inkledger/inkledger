// A tracker that refuses the saved credentials: the user stays in, a bar asks to reconnect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { start, trpcProcs, withApp } from "./harness.mjs";

/** A Jira Server asking for a CAPTCHA after failed logins: every API call is a 401 saying so (on a private address: never loopback). */
async function captchaJira() {
  const host = Object.values(networkInterfaces())
    .flat()
    .find(a => a && a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))?.address;
  assert.ok(host, "a private IPv4 address on this machine");
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    res.writeHead(401, { "Content-Type": "text/html", "X-Seraph-LoginReason": "AUTHENTICATION_DENIED", "X-Authentication-Denied-Reason": "CAPTCHA_CHALLENGE; login-url=/login.jsp" });
    res.end("<html></html>");
  });
  await new Promise(resolve => server.listen(0, host, resolve));
  return { host, url: `http://${host}:${server.address().port}`, calls: () => calls, close: () => new Promise(resolve => server.close(resolve)) };
}

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

test("a tracker out of reach too many times: retried in the background, Retry runs the user's own sync", () =>
  withApp({ seed: db => db.q("UPDATE connections SET status = 'unreachable'") }, async ({ page, base }) => {
    await page.goto(base + "/");
    const bar = page.getByRole("status").filter({ hasText: "retrying in the background" });
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

test("a failed sync is said in the user's words, not as the recorded kind and status", () =>
  withApp({
    seed: async db => {
      const at = Date.now() + 60_000;
      await db.q("UPDATE sync_state SET last_error = 'unavailable (503): Jira answered 503', last_error_at = ? WHERE user_id = 1", at);
      await db.q(
        "INSERT INTO connection_sync (connection_id, stream, last_error, last_error_at) SELECT id, 'issues', 'forbidden (403): Forbidden', ? FROM connections ON CONFLICT (connection_id, stream) DO UPDATE SET last_error = excluded.last_error, last_error_at = excluded.last_error_at",
        at,
      );
    },
  }, async ({ page, base }) => {
    await page.goto(base + "/settings/connections");
    // A refusal that isn't the credentials' leaves the status "ok": the row says the last failure.
    await page.getByText("last sync failed: access denied").waitFor();
    assert.equal(await page.getByText(/\(403\)|Forbidden/).count(), 0);
    const title = await page.getByRole("button", { name: /^Sync / }).first().getAttribute("title");
    assert.match(title ?? "", /the server answered with an error/);
    assert.doesNotMatch(title ?? "", /unavailable|503/);
  }));

test("Jira asking for a CAPTCHA: the reconnect form says why, with the steps, and the user stays signed in", async () => {
  const jira = await captchaJira();
  try {
    await withApp({ env: { REMOTE_ALLOWED_HOSTS: jira.host }, seed: db => db.q("UPDATE connections SET status = 'auth_failed', base_url = ?", jira.url) }, async ({ page, base }) => {
      await page.goto(base + "/settings/connections?reconnect=1");
      const dialog = page.getByRole("dialog");
      await dialog.locator("#reconnect-jira-site").fill(jira.url);
      await dialog.locator("#reconnect-jira-username").fill("mrossi");
      await dialog.locator("#reconnect-jira-secret").fill("the password");
      await dialog.getByRole("button", { name: "Reconnect" }).click();
      // Said in the form, not a sign-out that starts the form over.
      const alert = dialog.getByRole("alert");
      await alert.waitFor();
      const said = await alert.innerText();
      assert.match(said, /asking for a CAPTCHA/);
      assert.match(said, /1\. Sign out of Jira in your browser\.\n2\. Sign in to Jira again, solving the CAPTCHA\.\n3\. Then try here once\./);
      assert.equal(new URL(page.url()).pathname, "/settings/connections");
      assert.equal(await dialog.locator("#reconnect-jira-secret").inputValue(), "the password");
      // One sign-in per click: nothing retried behind the user's back.
      assert.equal(jira.calls(), 1);
    });
  } finally {
    await jira.close();
  }
});
