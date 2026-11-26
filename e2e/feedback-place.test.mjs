// Feedback as a page of its own (/feedback): reached from the sidebar's tiles, the phone's More and ⌘K;
// "New feedback" always there, so one sent never hides the way to the next; Info's old tab lands here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** Fills and sends the open "Send feedback" dialog; it closes and a new opening starts empty. */
async function send(page, title) {
  const sheet = page.getByRole("dialog", { name: "Send feedback" });
  await sheet.waitFor();
  assert.equal(await sheet.getByLabel("Title").inputValue(), "", "a new feedback starts empty");
  await sheet.getByLabel("Title").fill(title);
  await sheet.getByRole("button", { name: "Send" }).click();
  await sheet.waitFor({ state: "detached" });
}

test("two feedbacks in a row from the page, then two from the account menu and one from ⌘K", () =>
  withApp({ viewport: { width: 1400, height: 900 } }, async ({ page, base, db }) => {
    await page.goto(base + "/feedback");
    await page.getByRole("heading", { level: 1, name: "Feedback" }).waitFor();
    // Empty: the header's action and the empty state's both start one.
    const header = page.locator("main").getByRole("button", { name: "New feedback" });
    await page.getByText("No feedback yet").waitFor();
    assert.equal(await header.count(), 2);
    await header.first().click();
    await send(page, "First from the page");
    const list = page.getByRole("list", { name: "Feedback" });
    await list.getByRole("link", { name: /First from the page/ }).waitFor();
    // One in the list: the header's "New feedback" is still there.
    await header.first().click();
    await send(page, "Second from the page");
    await list.getByRole("link", { name: /Second from the page/ }).waitFor();

    for (const title of ["First from the menu", "Second from the menu"]) {
      await page.getByRole("button", { name: "Account menu" }).first().click();
      await page.getByRole("menuitem", { name: "Send feedback" }).click();
      await send(page, title);
      await list.getByRole("link", { name: new RegExp(title) }).waitFor();
    }
    await page.keyboard.press(`${MOD}+k`);
    await page.locator('[role="dialog"]').first().waitFor();
    await page.keyboard.type("Send feedback");
    await page.keyboard.press("Enter");
    await send(page, "From the palette");
    await list.getByRole("link", { name: /From the palette/ }).waitFor();
    assert.equal((await db.q("SELECT id FROM feedback WHERE user_id = 1")).length, 5);
  }));

test("the sidebar's Feedback tile opens the page, with a badge while one's own feedback has news", () =>
  withApp(
    {
      viewport: { width: 1400, height: 900 },
      seed: async db => {
        await db.q("INSERT INTO feedback (id, user_id, type, title, body, page, status, created_at, updated_at) VALUES (1, 1, 'problem', 'The board jumps', '', '/board', 'accepted', 1, 1)");
        await db.q("INSERT INTO notifications (user_id, connection_id, kind, issue_key, detail, dedupe, created_at) VALUES (1, NULL, 'alert', '', ?, 'feedback:1:status:1', ?)", JSON.stringify({ kind: "feedback", name: "The board jumps", ref: 1, what: "status" }), Date.now());
      },
    },
    async ({ page, base }) => {
      await page.goto(base + "/");
      const tools = page.locator("aside").getByRole("group", { name: "Tools" });
      const tile = tools.getByRole("link", { name: /^Feedback/ });
      await tile.waitFor();
      // Beside Settings and Info, among the tiles.
      assert.ok((await tools.getByRole("link").allInnerTexts()).some(text => /Settings/.test(text)));
      await tile.filter({ hasText: "1" }).waitFor();
      await tile.click();
      await page.waitForURL(u => u.pathname === "/feedback");
      await page.locator('aside a[href="/feedback"][aria-current="page"]').waitFor();
      // Opened: its news is read, the badge leaves.
      await page.getByRole("list", { name: "Feedback" }).getByRole("link", { name: /The board jumps/ }).click();
      await page.waitForURL(u => u.pathname === "/feedback/1");
      await page.getByRole("article").getByRole("heading", { name: "The board jumps" }).waitFor();
      await tile.filter({ hasText: "1" }).waitFor({ state: "detached" });

      // ⌘K's "Feedback" leads here too.
      await page.goto(base + "/");
      await page.keyboard.press(`${MOD}+k`);
      await page.locator('[role="dialog"]').first().waitFor();
      await page.keyboard.type("Feedback");
      await page.getByRole("option", { name: /^Feedback$/ }).click();
      await page.waitForURL(u => u.pathname === "/feedback");
    },
  ));

/** A running timer and three favourites: the sidebar at its fullest (as in ui-density). */
async function fullSidebar(db) {
  const now = Date.now();
  await db.q("UPDATE issues SET favorite = 1 WHERE key IN ('DEMO-101', 'DEMO-102', 'DEMO-103')");
  await db.q(
    "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
    now - 25 * 60_000, now, now,
  );
}

test("the sidebar at its fullest keeps every tile, Feedback included, without scrolling: 900 px in both densities and 700 px compact, open and closed", () =>
  withApp({ viewport: { width: 1280, height: 900 }, seed: fullSidebar }, async ({ page, base }) => {
    const problems = [];
    // 700 px comfortable open was 5 px short before this tile too (nine tiles are still three rows open).
    for (const [height, density] of [[900, "compact"], [900, "comfortable"], [700, "compact"]])
      for (const collapsed of ["0", "1"]) {
          await page.setViewportSize({ width: 1280, height });
          await page.goto(base + "/");
          await page.evaluate(([d, c]) => {
            localStorage.setItem("ikl-density", d);
            localStorage.setItem("ikl-sidebar-collapsed", c);
          }, [density, collapsed]);
          await page.reload();
          await page.locator("[data-surface-stage]").waitFor();
          await page.waitForTimeout(600);
          const r = await page.evaluate(() => {
            const aside = document.querySelector("aside");
            const box = aside.getBoundingClientRect();
            const tile = aside.querySelector('a[href="/feedback"]')?.getBoundingClientRect();
            const toggle = [...aside.querySelectorAll("button")].find(b => /^(Collapse|Expand)/.test(b.getAttribute("aria-label") || b.textContent.trim()))?.getBoundingClientRect();
            const scrolls = [aside, ...aside.querySelectorAll("*")].filter(e => e.scrollHeight > e.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && !e.closest("[data-favorites], [data-overflow-ok]") && e.querySelector('a[href="/feedback"]'));
            const inside = rect => !!rect && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
            return { tile: inside(tile), toggle: inside(toggle), scrolls: scrolls.length };
          });
          const where = `${height}px ${density} ${collapsed === "1" ? "closed" : "open"}`;
          if (!r.tile) problems.push(`${where}: Feedback tile cut`);
          if (!r.toggle) problems.push(`${where}: the toggle cut`);
          if (r.scrolls) problems.push(`${where}: the sections scroll`);
      }
    assert.deepEqual(problems, []);
  }));

test("on a phone: More holds Feedback, and its New feedback", () =>
  withApp(
    { viewport: { width: 390, height: 844 }, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
    async ({ page, base, db }) => {
      await page.goto(base + "/");
      await page.getByRole("button", { name: "More" }).first().click();
      await page.getByRole("dialog").getByRole("link", { name: "Feedback" }).click();
      await page.waitForURL(u => u.pathname === "/feedback");
      await page.locator("main").getByRole("button", { name: "New feedback" }).first().click();
      await send(page, "From the phone");
      await page.getByRole("list", { name: "Feedback" }).getByRole("link", { name: /From the phone/ }).waitFor();
      await page.locator("main").getByRole("button", { name: "New feedback" }).first().click();
      await send(page, "Again from the phone");
      assert.equal((await db.q("SELECT id FROM feedback")).length, 2);
    },
  ));

test("Info's old Feedback tab lands on /feedback, the one and its filters kept; Info has no tabs", () =>
  withApp(
    {
      seed: async db => {
        await db.q("INSERT INTO feedback (id, user_id, type, title, body, page, status, created_at, updated_at) VALUES (1, 1, 'idea', 'A weekly total', '', '/', 'new', 1, 1)");
      },
    },
    async ({ page, base }) => {
      await page.goto(base + "/info/feedback?scope=all&status=new");
      await page.waitForURL(u => u.pathname === "/feedback" && u.searchParams.get("scope") === "all" && u.searchParams.get("status") === "new");
      await page.getByRole("list", { name: "Feedback" }).getByRole("link", { name: /A weekly total/ }).waitFor();
      await page.goto(base + "/info/feedback/1");
      await page.waitForURL(u => u.pathname === "/feedback/1");
      await page.getByRole("article").getByRole("heading", { name: "A weekly total" }).waitFor();
      await page.goto(base + "/info?tab=feedback");
      await page.waitForURL(u => u.pathname === "/feedback" && !u.searchParams.has("tab"));
      // Back from the page does not bounce through Info.
      await page.goto(base + "/info");
      await page.getByRole("heading", { level: 1, name: "Info" }).waitFor();
      assert.equal(await page.locator("main").getByRole("tab").count(), 0);
    },
  ));
