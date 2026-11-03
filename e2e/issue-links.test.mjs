// Issue links: by identity, and old ones (a key, a key the issue had before) still arriving.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dayKey, lastWorkday, start, withApp } from "./harness.mjs";

test("an old link by key, or by a key the issue had before, lands on the issue's own link", () =>
  withApp(
    {
      seed: db =>
        db.q("INSERT INTO item_aliases (item_id, key, created_at) SELECT id, 'OLD-5', ? FROM issues WHERE key = 'DEMO-101'", Date.now()),
    },
    async ({ page, base, db }) => {
      const [{ connection_id: conn }] = await db.q("SELECT connection_id FROM issues WHERE key = 'DEMO-101'");
      for (const old of ["/issues/DEMO-101", "/issues/OLD-5"]) {
        await page.goto(base + old);
        await page.waitForURL(url => new URL(url).pathname === `/issues/${conn}/DEMO-101`);
        await page.getByText("Test task number 1").first().waitFor();
      }
      // From the list, the link is the issue's own already.
      await page.goto(base + "/issues");
      const href = await page.getByRole("link", { name: /DEMO-102/ }).first().getAttribute("href");
      assert.equal(href, `/issues/${conn}/DEMO-102?k=DEMO-102`);
    },
  ));

/** This machine's private address: the app never lets a tracker resolve to loopback (api/lib/security.ts). */
function privateAddress() {
  const found = Object.values(networkInterfaces())
    .flat()
    .find(a => a && a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  assert.ok(found, "a private IPv4 address on this machine");
  return found.address;
}

/** A Jira Server with one issue the catalogue doesn't have (a tracker search hit). */
async function fakeJira() {
  const host = privateAddress();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname.endsWith("/issue/GEOC-16618")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        id: "16618",
        key: "GEOC-16618",
        fields: {
          summary: "Planner outside the catalogue",
          status: { id: "1", name: "Aperto", statusCategory: { key: "new" } },
          project: { key: "GEOC", name: "Geo" },
          issuetype: { name: "Task" },
          priority: { name: "Media" },
          labels: [],
          components: [],
          assignee: null,
          updated: "2026-11-01T10:00:00.000+0100",
          created: "2026-10-01T10:00:00.000+0100",
        },
      }));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errorMessages: [`fake: ${req.method} ${url.pathname}${url.search}`] }));
  });
  await new Promise(resolve => server.listen(0, host, resolve));
  return { url: `http://${host}:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test("a link by identity to an issue not imported opens it live from its tracker, with Import", async () => {
  const jira = await fakeJira();
  try {
    await withApp({ seed: db => db.q("UPDATE connections SET base_url = ? WHERE id = 1", jira.url) }, async ({ page, base }) => {
      await page.goto(`${base}/issues/1/16618?k=GEOC-16618`);
      await page.getByRole("heading", { name: /Planner outside the catalogue/ }).first().waitFor();
      await page.getByRole("button", { name: /Import/ }).first().waitFor();
      assert.equal(await page.getByText("Page not found").count(), 0);
    });
  } finally {
    await jira.close();
  }
});

/** 10:00 on the last working day (Monday to Friday), and that day as the Dashboard's `from`. */
function lastWorkdayAt10() {
  const d = lastWorkday();
  d.setHours(10, 0, 0, 0);
  const day = dayKey(d);
  return { at: d.getTime(), day };
}

test("a logged slice of the day timeline opens its issue, by click or by keyboard", () => {
  const { at, day } = lastWorkdayAt10();
  return withApp(
    {
      seed: db =>
        db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-101', 'w-slice', ?, 3600, '', 1)", at),
    },
    async ({ page, base, db }) => {
      const [{ connection_id: conn }] = await db.q("SELECT connection_id FROM issues WHERE key = 'DEMO-101'");
      const slice = page.getByRole("link", { name: /^DEMO-101 from 10:00, 1 h/ });
      await page.goto(`${base}/?period=day&from=${day}`);
      await slice.click();
      await page.waitForURL(url => new URL(url).pathname === `/issues/${conn}/DEMO-101`);
      await page.getByText("Test task number 1").first().waitFor();
      // Keyboard: the slice takes focus, Enter opens it.
      await page.goto(`${base}/?period=day&from=${day}`);
      await slice.focus();
      await page.keyboard.press("Enter");
      await page.waitForURL(url => new URL(url).pathname === `/issues/${conn}/DEMO-101`);
    },
  );
});

test("a dialog opened on one issue doesn't follow the user to another (Back with it open)", () =>
  withApp({}, async ({ page, base, db }) => {
    const [{ connection_id: conn }] = await db.q("SELECT connection_id FROM issues WHERE key = 'DEMO-101'");
    const go = path => page.evaluate(p => {
      history.pushState({}, "", p);
      dispatchEvent(new PopStateEvent("popstate"));
    }, path);
    await page.goto(`${base}/issues/${conn}/DEMO-101`);
    await page.getByText("Test task number 1").first().waitFor();
    // To another issue in the same page, then its Log time dialog.
    await go(`/issues/${conn}/DEMO-102`);
    await page.getByText("Test task number 2").first().waitFor();
    await page.locator("main").getByRole("button", { name: "Log time" }).first().click();
    await page.getByRole("dialog").waitFor();
    // Back to the first issue with it still open (browser Back, the mouse's back button, ⌘[).
    await page.goBack();
    await page.waitForURL(url => new URL(url).pathname === `/issues/${conn}/DEMO-101`);
    await page.getByText("Test task number 1").first().waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole("dialog").count(), 0, "the other issue's dialog is gone");
  }));
