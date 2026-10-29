import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

const ROUTES = ["/", "/issues", "/issues/DEMO-101", "/timesheet", "/timesheet?view=month", "/board", "/reports", "/settings", "/settings/store", "/info", "/notes", "/notes/new", "/notes/trash", "/todos", "/pinboard"];
const VIEWPORTS = [320, 390, 768, 1024, 1400];
const TOKEN = "MAGA-398-ThisIsAVeryLongUnbrokenTokenThatMustNotPushActionsOutsideTheRow-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

async function seed(db) {
  const now = Date.now();
  await db.q("UPDATE issues SET summary = ? WHERE key = 'DEMO-101'", TOKEN);
  await db.q("UPDATE issues SET key = ? WHERE key = 'DEMO-102'", TOKEN);
  await db.q("INSERT INTO todos (user_id, text, position, created_at, updated_at) VALUES (1, ?, 0, ?, ?)", TOKEN, now, now);
  await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (1, 1, 'DEMO-101', 'pending-1', 3600, ?, ?, ?)", now - 3600000, TOKEN, now);
}

async function measure(page, route) {
  return page.evaluate(routeName => {
    const root = document.documentElement;
    const main = document.querySelector("main");
    for (const element of main?.querySelectorAll(".sr-only, [data-overflow-ok]") ?? []) element.style.display = "none";
    const rootOverflow = root.scrollWidth - root.clientWidth;
    const mainOverflow = main ? main.scrollWidth - main.clientWidth : 0;
    const actionRows = [...document.querySelectorAll("[data-action-row]")].filter(element => element.scrollWidth - element.clientWidth > 1).length;
    const clampedText = [...document.querySelectorAll("[class*='line-clamp-']")].filter(element => element.scrollWidth - element.clientWidth > 1).length;
    const controls = routeName === "/board" ? [] : [...document.querySelectorAll("main a[href], main button, main input, main textarea, main [role=combobox]")].filter(element => {
      if (!(element instanceof HTMLElement) || element.closest("[data-overflow-ok]")) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none" && (rect.left < -1 || rect.right > window.innerWidth + 1);
    }).map(element => `${element.tagName.toLowerCase()}:${element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 60)}`);
    return { rootOverflow, mainOverflow, actionRows, clampedText, controls };
  }, route);
}

for (const width of VIEWPORTS) {
  test(`no layout overflow at ${width}px`, async () => {
    const app = await start({ viewport: { width, height: 900 }, seed });
    try {
      await app.page.emulateMedia({ reducedMotion: "reduce" });
      for (const route of ROUTES) {
        await app.page.goto(app.base + route);
        await app.page.locator("[data-surface-stage]").waitFor();
        await app.page.waitForTimeout(1200);
        const result = await measure(app.page, route);
        assert.ok(result.rootOverflow <= 1, `${route}: document overflow ${result.rootOverflow}px`);
        assert.ok(result.mainOverflow <= 1, `${route}: main overflow ${result.mainOverflow}px`);
        assert.equal(result.actionRows, 0, `${route}: overflowing flexible rows`);
        assert.equal(result.clampedText, 0, `${route}: horizontally clipped text`);
        assert.deepEqual(result.controls, [], `${route}: controls outside viewport`);
      }
      assert.deepEqual(app.errors, [], "no page errors");
    } finally {
      await app.stop();
    }
  });
}
