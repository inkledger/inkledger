// React work while a timer runs (docs/dev/measuring.md): commits and component renders on
// the production bundle, counted by a DevTools hook. The counter is checked first on a
// fixture whose work is known; if it is wrong, nothing after it is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { chromiumPath } from "../scripts/chromium.mjs";
import { start } from "./harness.mjs";
import { renderHook, rendersDuring } from "./renders.mjs";

const WINDOW = 10_000;

test("the counter: a 1 s ticker commits 10 times in 10 s, its plain child too, its memo child and a static sibling never", async () => {
  const out = await build({
    entryPoints: [new URL("./fixtures/renders/app.jsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    minify: true,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  try {
    const page = await browser.newPage();
    await page.addInitScript(renderHook);
    // A real navigation (init scripts run on one), answered from here: nothing leaves.
    await page.route("http://fixture.test/**", route =>
      route.fulfill({ contentType: "text/html", body: `<div id="root"></div><script>${out.outputFiles[0].text.replace(/<\/script/g, "<\\/script")}</script>` }),
    );
    await page.goto("http://fixture.test/");
    await page.getByTestId("plain-child").waitFor();
    await page.waitForTimeout(1500);
    const r = await rendersDuring(page, WINDOW);
    const of = id => r.top.find(([k]) => k === `body ${id}`)?.[1] ?? 0;
    assert.ok(Math.abs(r.commits - 10) <= 1, `commits ${r.commits}`);
    assert.ok(Math.abs(of("ticker") - 10) <= 1, `ticker ${of("ticker")}`);
    assert.ok(Math.abs(of("plain-child") - 10) <= 1, `plain child ${of("plain-child")}`);
    assert.equal(of("memo-leaf"), 0, "memo child");
    assert.equal(of("static"), 0, "static sibling");
    assert.equal(r.renders, of("ticker") + of("plain-child"), `only those: ${JSON.stringify(r.top)}`);
  } finally {
    await browser.close();
  }
});

/**
 * Per 10 s with a timer running, page by page (and the dashboard without one): commits and
 * component renders. Before Wave 3 (frozen 2026-10-22, the most of three runs, which agreed
 * within one commit). A change may lower them, never raise them.
 */
const MEASURED = {
  "dashboard, no timer": { commits: 0, renders: 0 },
  "issue page": { commits: 11, renders: 394 },
  dashboard: { commits: 19, renders: 1670 },
  timesheet: { commits: 11, renders: 1460 },
};

test("React work per 10 s, a timer running", async () => {
  const app = await start({});
  const { page, base } = app;
  try {
    await page.context().addInitScript(renderHook);
    const measure = async name => {
      await page.waitForTimeout(5000);
      const r = await rendersDuring(page, WINDOW);
      console.info(`[measure] renders, ${name}: ${r.commits} commits, ${r.renders} component renders; most: ${r.top.slice(0, 4).map(([k, v]) => `${v} ${k}`).join(", ")}`);
      assert.ok(r.commits <= MEASURED[name].commits, `${name}: ${r.commits} commits`);
      assert.ok(r.renders <= MEASURED[name].renders, `${name}: ${r.renders} renders`);
    };
    await page.goto(base + "/");
    await measure("dashboard, no timer");
    await page.goto(base + "/issues/DEMO-101");
    await page.getByRole("button", { name: "Start timer DEMO-101" }).first().click();
    await page.getByRole("button", { name: "Pause timer DEMO-101" }).first().waitFor();
    await measure("issue page");
    await page.goto(base + "/");
    await measure("dashboard");
    await page.goto(base + "/timesheet");
    await measure("timesheet");
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
