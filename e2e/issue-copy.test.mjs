// Copy an issue for an agent (docs/work/ideas/issue-copy.md): Markdown on the clipboard,
// attachment links that open without a session, and stop when revoked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { withApp } from "./harness.mjs";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** This machine's private address: the app never lets a tracker resolve to loopback (api/lib/security.ts). */
function privateAddress() {
  const found = Object.values(networkInterfaces())
    .flat()
    .find(a => a && a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  assert.ok(found, "a private IPv4 address on this machine");
  return found.address;
}

/** A Jira Server on this machine with one issue, its description and one image attachment. */
async function fakeJira() {
  const host = privateAddress();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const base = `http://${host}:${server.address().port}`;
    const send = body => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.endsWith("/issue/DEMO-101") && url.searchParams.get("fields") === "description") return send({ fields: { description: "It breaks here:\n\n!shot.png!" } });
    if (url.pathname.endsWith("/issue/DEMO-101") && url.searchParams.get("fields") === "attachment")
      return send({ fields: { attachment: [{ id: "500", filename: "shot.png", mimeType: "image/png", size: PNG.length, content: `${base}/secure/attachment/500/shot.png` }] } });
    if (url.pathname.endsWith("/attachment/500")) return send({ id: "500", filename: "shot.png", mimeType: "image/png", content: `${base}/secure/attachment/500/shot.png` });
    if (url.pathname === "/secure/attachment/500/shot.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": PNG.length });
      return res.end(PNG);
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errorMessages: [`fake: ${req.method} ${url.pathname}${url.search}`] }));
  });
  await new Promise(resolve => server.listen(0, host, resolve));
  return { url: `http://${host}:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function copyForAgent(page, base, duration) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await page.goto(`${base}/issues/DEMO-101`);
  await page.getByRole("heading", { name: /Test task number 1/ }).first().waitFor();
  await page.getByRole("button", { name: "Copy key, branch name or the issue" }).click();
  await page.getByRole("group", { name: "Copy for an agent" }).getByRole("menuitem", { name: new RegExp(`^Links valid ${duration}`) }).click();
  await page.getByText(/Copied · links valid until/).waitFor();
  return page.evaluate(() => navigator.clipboard.readText());
}

test("an issue is copied for an agent with working links", async () => {
  const jira = await fakeJira();
  try {
    await withApp({ seed: async db => db.q("UPDATE connections SET base_url = ? WHERE id = 1", jira.url) }, async ({ page, base }) => {
      const md = await copyForAgent(page, base, "1 h");
      assert.match(md, /^# DEMO-101: Test task number 1\n/);
      assert.match(md, /- Status: To Do/);
      assert.match(md, /It breaks here:/);
      const link = /!\[shot\.png\]\((http[^)]+\/api\/shared\/[^)]+)\)/.exec(md)?.[1];
      assert.ok(link, md);
      assert.ok(md.includes(`- [shot.png](${link})`), "listed under Attachments");
      // Outside the browser, no cookie: the link alone opens it.
      const res = await fetch(link);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-disposition") ?? "", /^attachment/);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
      // Revoked from Settings: the same link is gone.
      await page.goto(`${base}/settings/links`);
      await page.getByRole("button", { name: "Revoke all links" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Revoke all links" }).click();
      await page.getByText("Links revoked").waitFor();
      assert.equal((await fetch(link)).status, 404);
    });
  } finally {
    await jira.close();
  }
});

test("copy for an agent at 320 px", async () => {
  for (const scheme of ["light", "dark"]) {
    await withApp({ viewport: { width: 320, height: 720 } }, async ({ page, base }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.goto(`${base}/issues/DEMO-101`);
      await page.getByRole("heading", { name: /Test task number 1/ }).first().waitFor();
      await page.getByRole("button", { name: "Copy key, branch name or the issue" }).click();
      const item = page.getByRole("menuitem", { name: /^Links valid 24 h/ });
      await item.waitFor();
      const box = await item.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 320, `${scheme}: the menu fits (${JSON.stringify(box)})`);
      assert.equal(await overflow(), 0, `${scheme}: issue page`);
      await page.keyboard.press("Escape");
      await page.goto(`${base}/settings/links`);
      await page.getByRole("button", { name: "Revoke all links" }).waitFor();
      assert.equal(await overflow(), 0, `${scheme}: settings`);
    });
  }
});

test("branch name and commit message: from the menu and with b / m, the key first in the message", () =>
  withApp({}, async ({ page, base }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.goto(`${base}/issues/DEMO-101`);
    await page.getByRole("heading", { name: /Test task number 1/ }).first().waitFor();
    const read = () => page.evaluate(() => navigator.clipboard.readText());
    await page.getByRole("button", { name: "Copy key, branch name or the issue" }).click();
    await page.getByRole("menuitem", { name: /^Copy commit message/ }).click();
    await page.getByText("Commit message copied").waitFor();
    assert.equal(await read(), "DEMO-101 Test task number 1");
    await page.keyboard.press("b");
    await page.waitForFunction(() => navigator.clipboard.readText().then(t => t.includes("/DEMO-101-")));
    assert.match(await read(), /^(feature|bugfix)\/DEMO-101-test-task-number-1$/);
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.keyboard.press("m");
    await page.waitForFunction(() => navigator.clipboard.readText().then(t => t.length > 0));
    assert.equal(await read(), "DEMO-101 Test task number 1");
  }));
