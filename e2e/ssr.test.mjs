import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

test("dashboard arrives with data and hydrates without browser or server errors", async () => {
  const app = await start();
  try {
    const consoleErrors = [];
    app.page.on("console", message => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const response = await app.page.goto(`${app.base}/`);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["cache-control"], "private, no-store");
    const html = await response.text();
    assert.match(html, /id="inkledger-ssr-state"/);
    assert.match(html, /Quick stats/, app.log());
    assert.doesNotMatch(html, /<div id="root"><\/div>/);
    assert.doesNotMatch(html, /\[\["timers","list"\]\]|\[\["notifications","count"\]\]/);
    await app.page.getByRole("heading", { name: "Quick stats", exact: true }).first().waitFor();
    assert.equal(await app.page.locator("#inkledger-ssr-state").count(), 0);
    assert.equal(new URL(app.page.url()).pathname, "/");
    assert.deepEqual(app.errors, []);
    assert.deepEqual(consoleErrors, []);
    assert.doesNotMatch(app.log(), /Unexpected tRPC fetch during SSR|\[ssr\]/);
  } finally {
    await app.stop();
  }
});

test("login is server-rendered and a signed-out dashboard redirects to it", async () => {
  const app = await start({ bare: true });
  try {
    const response = await app.page.goto(`${app.base}/`);
    await app.page.waitForURL(/\/login$/);
    const html = await response.text();
    assert.match(html, /id="inkledger-ssr-state"/);
    assert.match(html, /<form/);
    await app.page.getByLabel("Username", { exact: true }).waitFor();
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});

test("mobile Italian SSR uses the request locale and hydrates cleanly", async () => {
  const app = await start({ viewport: { width: 390, height: 844 }, userAgent: "SSR mobile test" });
  try {
    await app.context.addCookies([{ name: "ikl-locale", value: "it", url: app.base }]);
    const errors = [];
    app.page.on("console", message => {
      if (message.type() === "error") errors.push(message.text());
    });
    const response = await app.page.goto(`${app.base}/`);
    const html = await response.text();
    assert.match(html, /<html lang="it">/);
    assert.match(html, /Numeri rapidi/);
    assert.match(html, /id="inkledger-ssr-state"/);
    await app.page.locator("#root").getByRole("heading").first().waitFor();
    assert.deepEqual(app.errors, []);
    assert.deepEqual(errors, []);
  } finally {
    await app.stop();
  }
});

test("SSR state escapes markup and never includes another user's issues", async () => {
  const payload = "</script><script>alert(1)</script>";
  const app = await start({
    seed: async db => {
      const now = Date.now();
      await db.q("INSERT INTO users (id, username, password_hash, role, email, display_name, created_at) VALUES (2, 'other', null, 'member', 'other', 'Other User', ?)", now);
      await db.q("INSERT INTO connections (id, user_id, type, base_url, remote_account_id, display_name, options, encrypted_secret, legacy, created_at) VALUES (2, 2, 'jira', 'https://jira.example.it', 'other', 'Other User', '{}', '', 1, ?)", now);
      const issue = `INSERT INTO issues (user_id, jira_id, key, summary, status, status_category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at, favorite)
        VALUES (?, ?, ?, ?, 'To Do', 'To Do', 'X', 'Project', 'Task', 'Medium', '[]', 'mrossi', ?, ?, 0)`;
      await db.q(issue, 1, "XSS-1", "XSS-1", payload, "https://jira.example.it/browse/XSS-1", now);
      await db.q(issue, 2, "OTHER-1", "OTHER-1", "Another user's private summary", "https://jira.example.it/browse/OTHER-1", now);
    },
  });
  try {
    const response = await app.page.goto(`${app.base}/`);
    const html = await response.text();
    assert.doesNotMatch(html, /<\/script><script>alert\(1\)<\/script>/);
    assert.doesNotMatch(html, /Another user's private summary/);
    assert.deepEqual(app.errors, []);
  } finally {
    await app.stop();
  }
});

test("service worker caches only the anonymous shell, never private SSR HTML", async () => {
  const app = await start();
  try {
    await app.page.goto(`${app.base}/`);
    await app.page.waitForFunction(() => navigator.serviceWorker?.controller);
    const cached = await app.page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      const cache = await caches.open("inkledger-shell-v2");
      return (await cache.keys()).map(request => new URL(request.url).pathname);
    });
    assert.ok(cached.includes("/offline.html"));
    assert.ok(!cached.includes("/"));
    assert.ok(!cached.includes("/login"));
    await app.context.setOffline(true);
    await app.page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(await app.page.locator("#inkledger-ssr-state").count(), 0);
    await app.context.setOffline(false);
  } finally {
    await app.stop();
  }
});

test("a logout during SSR does not restore the old session or private HTML", async () => {
  const app = await start();
  try {
    await app.page.goto(`${app.base}/`);
    const pending = await app.context.newPage();
    let release = () => {};
    const held = new Promise(resolve => (release = resolve));
    await pending.route(`${app.base}/`, async route => {
      await held;
      await route.continue();
    });
    const navigation = pending.goto(`${app.base}/`).catch(() => undefined);
    const logout = await app.page.evaluate(() => fetch("/api/trpc/auth.logout?batch=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ 0: { json: null, meta: { values: ["undefined"], v: 1 } } }),
    }).then(response => response.status));
    assert.equal(logout, 200);
    release();
    await navigation.catch(() => undefined);
    await pending.waitForURL(/\/login$/);
    await pending.locator("form").waitFor();
    const html = await pending.content();
    assert.doesNotMatch(html, /Quick stats/);
    assert.match(html, /<form/);
  } finally {
    await app.stop();
  }
});
