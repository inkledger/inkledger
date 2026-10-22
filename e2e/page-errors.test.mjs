// A page that fails leaves the app around it: the sidebar, the header and the
// timer stay. Its code that never arrived (a redeploy, the network) offers a
// reload; a render error offers to draw again, and leaving the page clears it.
// Both are caused from outside the app: the chunk's request is cut, and one
// answer of the server is bent so the page throws while drawing. Nothing of
// this lives in the bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

const sidebarLink = (page, href) => page.locator(`nav a[href="${href}"]`).first();

test("a page whose code never arrives: one reload by itself, then the shell stays and offers a reload", async () => {
  const app = await start();
  try {
    const { page, context } = app;
    await page.goto(app.base + "/");
    await sidebarLink(page, "/reports").waitFor();
    // The Reports page's chunk, by its name whatever hash this build gave it; cut on the
    // whole context, so the service worker's own fetch of it is cut too.
    const chunk = u => /\/assets\/Reports-[\w-]+\.js$/.test(new URL(u).pathname);
    let cut = 0;
    await context.route(chunk, route => {
      cut++;
      return route.abort("failed");
    });
    let loads = 0;
    page.on("load", () => loads++);
    const reloaded = page.waitForEvent("load");
    await sidebarLink(page, "/reports").click();
    // The first failure reloads by itself (main.tsx); the alert is read on the reloaded page only.
    await reloaded;
    const alert = page.getByRole("alert").filter({ hasText: "Something went wrong" });
    await alert.waitFor();
    // main.tsx reloads once by itself (a redeploy's stale chunk); failing again within 10 s, the page says so.
    assert.equal(loads, 1, "one reload by itself, not a loop");
    assert.ok(cut >= 2, `the chunk was asked for again after the reload (${cut})`);
    assert.equal(await alert.getByRole("button", { name: "Retry" }).count(), 0, "no retry: React.lazy keeps the failure");
    assert.ok(await sidebarLink(page, "/").isVisible(), "the sidebar stays");
    assert.ok(new URL(page.url()).pathname === "/reports");

    await context.unroute(chunk);
    await alert.getByRole("button", { name: "Reload" }).click();
    await page.getByRole("heading", { name: "Reports", level: 1 }).waitFor();
    assert.equal(await alert.count(), 0);
  } finally {
    await app.stop();
  }
});

test("a page that throws while drawing: the shell stays, retry draws it again, leaving clears it", async () => {
  const app = await start();
  try {
    const { page } = app;
    let bend = true;
    // info.get answers a list as a number: the page's hosts.map throws while drawing.
    await page.route(u => new URL(u).pathname.startsWith("/api/trpc/") && new URL(u).pathname.includes("info.get"), async route => {
      const res = await route.fetch();
      if (!bend) return route.fulfill({ response: res });
      const procs = decodeURIComponent(new URL(route.request().url()).pathname.slice("/api/trpc/".length)).split(",");
      const body = await res.json();
      const i = procs.indexOf("info.get");
      body[i].result.data.json.tailnetOrigins = 42;
      return route.fulfill({ response: res, json: body });
    });
    await page.goto(app.base + "/info");
    const alert = page.getByRole("alert").filter({ hasText: "Something went wrong" });
    await alert.waitFor();
    assert.ok(await sidebarLink(page, "/").isVisible(), "the sidebar stays");
    assert.ok(app.errors.length === 0 || app.errors.every(e => /hosts\.map|is not a function/.test(e)), `only the page's own error: ${app.errors.join(" | ")}`);

    // Leaving the page clears it: the next page draws.
    await sidebarLink(page, "/timesheet").click();
    await page.waitForURL("**/timesheet");
    await page.locator("main h1").first().waitFor();
    assert.equal(await alert.count(), 0);

    // Back on the broken page; the server answers right again: retry reads the page afresh and draws it.
    await page.goBack();
    await alert.waitFor();
    bend = false;
    await alert.getByRole("button", { name: "Retry" }).click();
    await page.getByRole("heading", { name: "Info", level: 1 }).waitFor();
    assert.equal(await alert.count(), 0);
    assert.ok(await sidebarLink(page, "/").isVisible(), "the sidebar stayed throughout");
  } finally {
    // An answer still being bent must not outlive the page.
    await app.page.unrouteAll({ behavior: "ignoreErrors" });
    await app.stop();
  }
});

test("a page's code on its way: the page on screen stays until it is there, no spinner in between", async () => {
  const app = await start();
  try {
    const { page, context } = app;
    await page.goto(app.base + "/");
    await sidebarLink(page, "/reports").waitFor();
    const dashboard = page.locator("main h1").first();
    const before = await dashboard.innerText();
    // The Reports page's code takes a while to come.
    const chunk = u => /\/assets\/Reports-[\w-]+\.js$/.test(new URL(u).pathname);
    let release = () => {};
    const held = new Promise(r => (release = r));
    await context.route(chunk, async route => {
      await held;
      return route.continue();
    });
    await sidebarLink(page, "/reports").click();
    await page.waitForTimeout(600);
    assert.equal(await page.locator("main [role=status]").filter({ hasText: "Loading" }).count(), 0, "no spinner in place of the page");
    assert.equal(await dashboard.innerText(), before, "the page on screen stays");
    release();
    await page.getByRole("heading", { name: "Reports", level: 1 }).waitFor();
    await context.unroute(chunk);
  } finally {
    await app.stop();
  }
});

test("a dialog whose code never arrives: no reload by itself, the error shows in the dialog, the shell stays", async () => {
  const app = await start();
  try {
    const { page, context } = app;
    // The new-issue form's chunk, cut before the app loads: its fetch ahead of use fails too.
    const chunk = u => /\/assets\/CreateIssueForm-[\w-]+\.js$/.test(new URL(u).pathname);
    let cut = 0;
    await context.route(chunk, route => {
      cut++;
      return route.abort("failed");
    });
    let loads = 0;
    page.on("load", () => loads++);
    await page.goto(app.base + "/issues");
    await sidebarLink(page, "/reports").waitFor();
    // Fetched when the browser is free after start: failing then reloads nothing.
    for (let i = 0; i < 50 && cut === 0; i++) await page.waitForTimeout(200);
    assert.ok(cut >= 1, "the form was fetched ahead of use");
    await page.waitForTimeout(1500);
    assert.equal(loads, 1, "no reload by itself");

    await page.getByRole("button", { name: "New issue" }).first().click();
    const dialog = page.getByRole("dialog");
    const alert = dialog.getByRole("alert").filter({ hasText: "Something went wrong" });
    await alert.waitFor();
    assert.equal(await alert.getByRole("button", { name: "Retry" }).count(), 0, "no retry: React.lazy keeps the failure");
    assert.ok(await sidebarLink(page, "/").isVisible(), "the sidebar stays");

    await context.unroute(chunk);
    await alert.getByRole("button", { name: "Reload" }).click();
    await page.getByRole("button", { name: "New issue" }).first().click();
    await page.getByRole("dialog").getByRole("combobox", { name: "Project" }).waitFor();
  } finally {
    await app.stop();
  }
});

test("a page's code failing while a dialog's is still on its way still reloads the page by itself", async () => {
  const app = await start();
  try {
    const { page, context } = app;
    // The new-issue form's chunk held back (its fetch ahead of use under way), the Reports page's cut.
    const part = u => /\/assets\/CreateIssueForm-[\w-]+\.js$/.test(new URL(u).pathname);
    const held = [];
    await context.route(part, route => void held.push(route));
    const reports = u => /\/assets\/Reports-[\w-]+\.js$/.test(new URL(u).pathname);
    await context.route(reports, route => route.abort("failed"));
    let loads = 0;
    page.on("load", () => loads++);
    await page.goto(app.base + "/");
    await sidebarLink(page, "/reports").waitFor();
    for (let i = 0; i < 50 && held.length === 0; i++) await page.waitForTimeout(200);
    assert.ok(held.length >= 1, "the dialog's code is on its way");
    const reloaded = page.waitForEvent("load");
    await sidebarLink(page, "/reports").click();
    await reloaded;
    assert.equal(loads, 2, "the page reloaded by itself once");
    for (const r of held) await r.abort("failed").catch(() => {});
  } finally {
    await app.stop();
  }
});
