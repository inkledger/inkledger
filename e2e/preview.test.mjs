import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

test("dev preview serves the built app with SSR, working APIs and a development database", async () => {
  const app = await start({ devBuild: true });
  try {
    const health = await fetch(`${app.base}/api/health`);
    assert.equal(health.ok, true);

    const response = await app.page.goto(`${app.base}/`);
    assert.equal(response.status(), 200, app.log());
    const html = await response.text();
    assert.match(html, /<meta name="app-build" content="[^"]+"/);
    assert.match(html, /id="inkledger-ssr-state"/);
    assert.match(html, /Quick stats/);
    await app.page.getByRole("heading", { name: "Quick stats", exact: true }).first().waitFor();
    assert.equal(await app.page.locator("#inkledger-ssr-state").count(), 0);
    assert.deepEqual(app.errors, []);

    const me = await app.page.evaluate(() => fetch("/api/trpc/auth.me").then(response => response.ok));
    assert.equal(me, true);

    const entry = /<script[^>]*type="module"[^>]*src="(\/assets\/[^"]+)"/.exec(html)?.[1];
    assert.ok(entry);
    const asset = await fetch(`${app.base}${entry}`, { headers: { "accept-encoding": "br" } });
    assert.equal(asset.headers.get("content-encoding"), "br");
    assert.match(asset.headers.get("cache-control"), /immutable/);

    const owner = await app.db.q("SELECT value FROM server_settings WHERE key = 'db.owner'");
    assert.deepEqual(owner, []);
    assert.match(app.log(), /Serving the production build with the development configuration/);
  } finally {
    await app.stop();
  }
});
