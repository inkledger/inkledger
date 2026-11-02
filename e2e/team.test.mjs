// The team report (viewTeamTime): a heat map of everyone's hours against
// their own target; filters, search, a person's period and a day, read only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

const OCTOBER = "/team?from=2026-10-01&to=2026-10-31";
const at = (day, hour, month = 9) => new Date(2026, month, day, hour).getTime();
const weekday = (day, month = 9) => ![0, 6].includes(new Date(2026, month, day).getDay());

/**
 * Thirty people beside Mario. Giulia logs 8h every working day, Luca 4h
 * (below target) and is away on 7 October, Sara's Jira wasn't read for
 * days (to check); the others log 7.5h (above the 90% line). September too, to compare with.
 */
async function seedTeam(db) {
  const now = Date.now();
  const names = ["Giulia Bianchi", "Luca Verdi", "Sara Neri", ...Array.from({ length: 27 }, (_, i) => `Person ${String(i + 1).padStart(2, "0")}`)];
  let w = 0;
  for (const [i, name] of names.entries()) {
    const id = i + 2;
    await db.q("INSERT INTO users (id, username, role, display_name, created_at) VALUES (?, ?, 'member', ?, ?)", id, `u${id}`, name, now);
    await db.q("INSERT INTO connections (id, user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, ?, 'jira', 'https://jira.example.it', ?, '{}', 'x', ?)", id, id, `u${id}`, now);
    await db.q("INSERT INTO connection_sync (connection_id, stream, last_ok_at) VALUES (?, 'worklogs', ?)", id, name === "Sara Neri" ? now - 4 * 86_400_000 : now);
    const hours = name === "Giulia Bianchi" ? 8 : name === "Luca Verdi" ? 4 : 7.5;
    for (const month of [8, 9]) {
      for (let d = 1; d <= (month === 8 ? 30 : 31); d++) {
        if (!weekday(d, month) || (name === "Luca Verdi" && month === 9 && d === 7)) continue;
        await db.q(
          "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id, id, d % 2 ? "APP-1" : "WEB-2", `w${w++}`, hours * 3600, at(d, 9, month), now,
        );
      }
    }
  }
  await db.q("INSERT INTO planned_entries (user_id, kind, starts_at, ends_at, created_at, updated_at) VALUES (3, 'vacation', ?, ?, 1, 1)", at(7, 0), at(8, 0));
  await db.q("INSERT INTO sync_state (user_id, last_worklog_sync_at) VALUES (1, ?) ON CONFLICT (user_id) DO UPDATE SET last_worklog_sync_at = ?", now, now);
}

const rowNames = page => page.getByRole("table").locator("tbody th").allInnerTexts();

test("the heat map: a row per person, filters, search, sort and a day read only", () =>
  withApp({ seed: seedTeam }, async ({ page, base }) => {
    await page.goto(base + OCTOBER);
    const table = page.getByRole("table", { name: "Hours by person and day" });
    await table.waitFor();
    // Thirty-odd people fit: at least twenty rows on screen without scrolling the page.
    const visible = await table.locator("tbody tr").evaluateAll(rows => rows.filter(r => r.getBoundingClientRect().bottom <= window.innerHeight).length);
    assert.ok(visible >= 20, `${visible} rows on screen`);
    assert.match((await rowNames(page))[0], /Giulia Bianchi/, "most hours first");

    // Below target: under 90% of what was expected so far.
    await page.getByRole("button", { name: /Below target/ }).click();
    await page.waitForURL(url => new URL(url).searchParams.get("show") === "below");
    // Luca (4h a day) and Mario (nothing logged); the KPI counts the same two.
    const belowRows = await rowNames(page);
    assert.equal(belowRows.length, 2);
    assert.match(belowRows.join(" "), /Luca Verdi.*Mario Rossi/s);
    await page.getByRole("button", { name: /Below target\s*2/ }).waitFor();
    await page.getByRole("radio", { name: /^All/ }).click();

    // Search by name, accents and case aside.
    await page.getByRole("searchbox", { name: "Search person" }).fill("sara");
    await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length === 1);
    await page.getByRole("searchbox", { name: "Search person" }).fill("");
    await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length > 20);

    // By name; the period stays.
    await page.getByRole("radio", { name: "Name" }).click();
    await page.waitForURL(url => new URL(url).searchParams.get("sort") === "name");
    assert.match((await rowNames(page))[0], /Giulia Bianchi/);

    // Luca's 7 October: away. His 5 October opens the day, its worklog drawn, opening nothing.
    await table.getByRole("button", { name: /^Luca Verdi · Wed 7 Oct · absent/ }).waitFor();
    await table.getByRole("button", { name: /^Luca Verdi · Mon 5 Oct/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: /Luca Verdi · Monday 5 October/ }).waitFor();
    await dialog.getByRole("img", { name: /WEB-2|APP-1/ }).first().waitFor();
    assert.equal(await dialog.getByRole("link").count(), 0, "someone else's issue is not a link");
  }));

test("keyboard: one Tab stop, arrows move, the readout says the cell", () =>
  withApp({ seed: seedTeam }, async ({ page, base }) => {
    await page.goto(base + OCTOBER + "&sort=name");
    const table = page.getByRole("table", { name: "Hours by person and day" });
    await table.waitFor();
    await table.getByRole("button", { name: /^Giulia Bianchi · Thu 1 Oct/ }).focus();
    await page.keyboard.press("ArrowRight");
    assert.match(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""), /^Giulia Bianchi · Fri 2 Oct/);
    await page.keyboard.press("ArrowDown");
    assert.match(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""), /^Luca Verdi · Fri 2 Oct/);
    await page.getByText(/^Luca Verdi · Fri 2 Oct · 4 h of 8 h \(50%\)$/).waitFor();
    // Only one cell takes the Tab.
    assert.equal(await table.locator('tbody [tabindex="0"]').count(), 1);
  }));

test("a person's period opens beside the map; Back closes it", () =>
  withApp({ seed: seedTeam }, async ({ page, base }) => {
    await page.goto(base + OCTOBER);
    await page.getByRole("button", { name: /^Open Sara Neri's period/ }).click();
    await page.waitForURL(url => new URL(url).searchParams.get("person") !== null);
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("heading", { name: "Sara Neri" }).waitFor();
    await sheet.getByText("Synced 4 days ago").waitFor();
    await sheet.getByText(/^APP-1/).first().waitFor();
    // Back closes the panel and stays on the map, as it was.
    await page.goBack();
    await sheet.waitFor({ state: "detached" });
    assert.equal(new URL(page.url()).pathname, "/team");
    assert.equal(new URL(page.url()).searchParams.get("from"), "2026-10-01");
    await page.getByRole("table", { name: "Hours by person and day" }).waitFor();
    // Its own close does the same: one step back, not a second entry.
    await page.getByRole("button", { name: /^Open Luca Verdi's period/ }).click();
    await sheet.getByRole("heading", { name: "Luca Verdi" }).waitFor();
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    assert.equal(new URL(page.url()).searchParams.get("person"), null);
    assert.equal(new URL(page.url()).pathname, "/team");
  }));

test("two quick changes never undo each other (the URL is read as it is now)", () =>
  withApp({ seed: seedTeam }, async ({ page, base }) => {
    await page.goto(base + OCTOBER + "&show=below");
    await page.getByRole("table").waitFor();
    // Both in one task: the second change lands before the page has re-rendered from the first.
    await page.evaluate(() => {
      const all = [...document.querySelectorAll('[role="radio"]')].find(r => /^All/.test(r.textContent ?? ""));
      all.click();
      const box = document.querySelector('input[type="search"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(box, "sara");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForFunction(() => new URL(location.href).searchParams.get("q") === "sara");
    assert.equal(new URL(page.url()).searchParams.get("show"), null, "All stays chosen");
    await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length === 1);
  }));

test("a quarter shows weeks; a week opens its days", () =>
  withApp({ seed: seedTeam }, async ({ page, base }) => {
    await page.goto(base + "/team?from=2026-08-01&to=2026-10-31");
    await page.getByRole("table", { name: "Hours by person and week" }).waitFor();
    await page.getByRole("button", { name: /^Giulia Bianchi · W41 · 5–11 Oct.*open its days/ }).click();
    await page.waitForURL(url => new URL(url).searchParams.get("from") === "2026-10-05");
    await page.getByRole("table", { name: "Hours by person and day" }).waitFor();
  }));

test("on a phone: nothing scrolls the page sideways, the names stay in view", () =>
  withApp({ seed: seedTeam, viewport: { width: 320, height: 700 } }, async ({ page, base }) => {
    await page.goto(base + OCTOBER);
    await page.getByRole("table").waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
    // The map scrolls inside itself; the name column stays put.
    const name = page.getByRole("button", { name: /^Open Giulia Bianchi's period/ });
    const before = await name.boundingBox();
    await page.getByRole("table").evaluate(t => t.parentElement.scrollBy(400, 0));
    const after = await name.boundingBox();
    assert.ok(Math.abs(after.x - before.x) <= 1, "the name column is sticky");
  }));

test("without the permission: no menu entry, and the page says so", () =>
  withApp({ seed: async db => { await seedTeam(db); await db.q("UPDATE users SET role = 'member' WHERE id = 1"); } }, async ({ page, base }) => {
    await page.goto(base + "/reports");
    await page.getByRole("link", { name: "Reports" }).first().waitFor();
    assert.equal(await page.getByRole("link", { name: "Team time" }).count(), 0);
    await page.goto(base + OCTOBER);
    await page.getByText("Team time isn't available to you").waitFor();
    assert.equal(await page.getByText("Giulia Bianchi").count(), 0);
  }));
