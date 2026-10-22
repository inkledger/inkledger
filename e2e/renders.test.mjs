// React work while a timer runs (docs/dev/measuring.md): commits and component renders on
// the production bundle, counted by a DevTools hook, over five minutes of the page's own
// clock. The counter and the clock stepping are checked first on a fixture whose work is
// known; if they are wrong, nothing after them is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { chromiumPath } from "../scripts/chromium.mjs";
import { start } from "./harness.mjs";
import { clockStepper, renderHook, rendersOver, streamProbe } from "./renders.mjs";

test("the counter: a 1 s ticker commits once a second, its plain child too, its memo child and a static sibling never", async () => {
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
    const check = (r, n, how) => {
      const of = id => r.top.find(([k]) => k === `body ${id}`)?.[1] ?? 0;
      assert.ok(Math.abs(r.commits - n) <= 1, `${how}: commits ${r.commits}`);
      assert.ok(Math.abs(of("ticker") - n) <= 1, `${how}: ticker ${of("ticker")}`);
      assert.ok(Math.abs(of("plain-child") - n) <= 1, `${how}: plain child ${of("plain-child")}`);
      assert.equal(of("memo-leaf"), 0, `${how}: memo child`);
      assert.equal(of("static"), 0, `${how}: static sibling`);
      assert.equal(r.renders, of("ticker") + of("plain-child"), `${how}: only those, ${JSON.stringify(r.top)}`);
    };

    // In real time.
    await page.goto("http://fixture.test/");
    await page.getByTestId("plain-child").waitFor();
    await page.waitForTimeout(1500);
    check(await rendersOver(page, () => page.waitForTimeout(10_000)), 10, "real time");

    // On the page's clock, stepped a second at a time: exactly one commit per step.
    await page.clock.install();
    await page.goto("http://fixture.test/");
    const clock = clockStepper(page);
    await clock.run(3000);
    const r = await rendersOver(page, () => clock.run(30_000));
    check(r, 30, "stepped");
    assert.equal(r.commits, 30, "stepped: exact");
  } finally {
    await browser.close();
  }
});

/**
 * The window: five minutes of the page's clock, the least common multiple of everything the
 * app does on a period (the 1 s clock; polls every 15, 30 and 60 s; the timer heartbeat every
 * 25 s). Whatever the phase, each happens a fixed number of times in it, so the counts are
 * exact. A step waits for the requests it started.
 */
const WINDOW = 300_000;

/**
 * Per five minutes, page by page: commits and component renders, at most, in a window with the
 * event stream up (a broken one doesn't count; over twice with it up fails). Before Wave 3
 * (frozen 2026-10-22, two runs within 2%): no timer 55 / 15221; with one running, issue page
 * 712 / 21929, dashboard 1013 / 73998, timesheet 1001 / 66823. After the shared clock: 41 /
 * 13840, 366 / 20452, 366 / 24399, 366 / 23704. A poll that changes nothing no longer
 * re-renders the layout: no timer 41 / 4620. The shell's background effects in a component
 * of their own: 40 / 2889, 367 / 6044, 366 / 9883, 367 / 9296. The pinboard's page in the
 * menu (one link more in the sidebar, drawn with it on each of its commits): 40 / 2990,
 * 366 / 6139, 367 / 9992, 366 / 9396.
 * Each limit is the most
 * measured since, plus 2% (network timing moves a poll's work by a commit or two). A change
 * that lowers them lowers them here; raising one is a deliberate edit with its reason in the
 * commit, never a side effect.
 */
const MEASURED = {
  "dashboard, no timer": { commits: 42, renders: 3050 },
  "issue page, timer running": { commits: 374, renders: 6170 },
  "dashboard, timer running": { commits: 374, renders: 10090 },
  "timesheet, timer running": { commits: 374, renders: 9480 },
};

test("React work per five minutes, page by page", async () => {
  const app = await start({});
  const { page, base } = app;
  try {
    await page.context().addInitScript(renderHook);
    await page.context().addInitScript(streamProbe);
    await page.clock.install();
    const clock = clockStepper(page);
    const open = async path => {
      await page.goto(base + path);
      await clock.run(5000, 100);
    };
    // What the page asked for during a window, by procedure, and whether its event stream held.
    // The counts are defined with the stream up: a window in which it dropped or reconnected (the
    // page then polls at its fallback rate and refetches everything when back; seen on a loaded
    // machine, never on its own) is not one, and is measured again once it is back.
    const asked = {};
    let counting = false;
    page.on("request", q => {
      if (!counting) return;
      const k = q.resourceType() === "eventsource" ? "event stream (re)opened" : decodeURIComponent(new URL(q.url()).pathname.replace("/api/trpc/", ""));
      asked[k] = (asked[k] ?? 0) + 1;
    });
    const stream = () => page.evaluate(() => ({ ...window.__stream }));
    const window5min = async () => {
      for (const k of Object.keys(asked)) delete asked[k];
      const before = await stream();
      counting = true;
      const r = await rendersOver(page, () => clock.run(WINDOW));
      counting = false;
      const after = await stream();
      const clean = after.errors === before.errors && after.opens === before.opens;
      if (!clean) asked["event stream errors, opens"] = `${after.errors - before.errors}, ${after.opens - before.opens}`;
      return { ...r, asked: { ...asked }, clean };
    };
    const over = (name, r) => r.commits > MEASURED[name].commits || r.renders > MEASURED[name].renders;
    const line = (name, r) =>
      `${name}: ${r.commits} commits, ${r.renders} component renders${r.clean ? "" : " (event stream broke)"}; most: ${r.top.slice(0, 5).map(([k, v]) => `${v} ${k}`).join(", ")}; asked: ${JSON.stringify(r.asked)}`;
    // A window with the stream broken doesn't count (up to four in all); with it up, the first
    // under its limit passes and a second over it fails. A real regression is over in every clean
    // window (checked by lowering a limit under the measure).
    const measure = async name => {
      const seen = [];
      let cleanOver = 0;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await page.waitForTimeout(5000); // real time: the stream reconnects by itself
        const r = await window5min();
        seen.push(r);
        console.info(`[measure] ${attempt ? "again, " : "renders per 5 min, "}${line(name, r)}`);
        if (!r.clean) continue;
        if (!over(name, r)) return;
        if (++cleanOver === 2) break;
      }
      assert.fail(`${cleanOver === 2 ? "over the limit in two windows with the stream up" : "no window with the stream up under the limit"}. ${seen.map(r => line(name, r)).join(" | ")}`);
    };
    await open("/");
    // The probe sees the app's own stream, or no window could be told clean from broken.
    assert.ok((await stream()).opens >= 1, "the event stream is up and seen by the probe");
    await measure("dashboard, no timer");
    await open("/issues/DEMO-101");
    await page.getByRole("button", { name: "Start timer DEMO-101" }).first().click();
    await clock.run(2000, 100);
    await page.getByRole("button", { name: "Pause timer DEMO-101" }).first().waitFor();
    await measure("issue page, timer running");
    await open("/");
    await measure("dashboard, timer running");
    await open("/timesheet");
    await measure("timesheet, timer running");
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
