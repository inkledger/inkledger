// The team report (viewTeamTime): everyone's logged hours over a period,
// ranked, and a day of someone else's opened read only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

const WEEK = "/team?from=2026-10-05&to=2026-10-11";
const at = (day, hour) => new Date(2026, 9, day, hour).getTime();

/** Giulia logs more than Mario that week; both on their own Jira. */
async function seedTeam(db) {
  const now = Date.now();
  await db.q("INSERT INTO users (id, username, role, display_name, created_at) VALUES (2, 'giulia', 'member', 'Giulia Bianchi', ?)", now);
  await db.q(
    "INSERT INTO connections (id, user_id, type, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (2, 2, 'jira', 'https://jira.example.it', 'giulia', 'Giulia', '{}', 'x', ?)",
    now,
  );
  await db.q("INSERT INTO connection_sync (connection_id, stream, last_ok_at) VALUES (2, 'worklogs', ?)", now);
  const log = (user, conn, key, started, seconds) =>
    db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)", user, conn, key, `w${user}-${started}`, seconds, started, now);
  await log(2, 2, "APP-1", at(5, 9), 6 * 3600);
  await log(2, 2, "APP-2", at(6, 9), 4 * 3600);
  await log(1, 1, "DEMO-101", at(5, 10), 2 * 3600);
}

test("whoever may see team time ranks everyone and opens someone's day, read only", () =>
  withApp({ seed: seedTeam }, async ({ page, base }) => {
    await page.goto(base + WEEK);
    await page.getByRole("link", { name: "Team time" }).first().waitFor();
    await page.getByRole("heading", { name: "Ranking" }).waitFor();
    const ranking = page.getByRole("list", { name: "Ranking" });
    await ranking.getByRole("listitem").filter({ hasText: "Mario Rossi" }).waitFor();
    const names = await ranking.getByRole("listitem").allInnerTexts();
    assert.match(names[0], /Giulia Bianchi/, "most hours first");
    assert.match(names[1], /Mario Rossi/);

    // Sorting by coverage keeps the period and goes in the URL (Back finds it).
    await page.getByRole("radio", { name: "Coverage" }).click();
    await page.waitForURL(url => new URL(url).searchParams.get("sort") === "coverage");
    assert.equal(new URL(page.url()).searchParams.get("from"), "2026-10-05");

    // Giulia's Monday: her worklog on the hour axis, opening nothing.
    const row = page.getByRole("list", { name: "Day by day" }).getByRole("listitem").filter({ hasText: "Giulia Bianchi" });
    await row.getByRole("button", { name: /^Monday 5 October/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: /Giulia Bianchi · Monday 5 October/ }).waitFor();
    await dialog.getByRole("img", { name: /APP-1/ }).waitFor();
    assert.equal(await dialog.getByRole("link", { name: /APP-1/ }).count(), 0, "someone else's issue is not a link");
  }));

test("without the permission: no menu entry, and the page says so", () =>
  withApp({ seed: async db => { await seedTeam(db); await db.q("UPDATE users SET role = 'member' WHERE id = 1"); } }, async ({ page, base }) => {
    await page.goto(base + "/reports");
    await page.getByRole("link", { name: "Reports" }).first().waitFor();
    assert.equal(await page.getByRole("link", { name: "Team time" }).count(), 0);
    await page.goto(base + WEEK);
    await page.getByText("Team time isn't available to you").waitFor();
    assert.equal(await page.getByText("Giulia Bianchi").count(), 0);
  }));

test("on a phone the month fits: nothing scrolls the page sideways", () =>
  withApp({ seed: seedTeam, viewport: { width: 320, height: 700 } }, async ({ page, base }) => {
    await page.goto(base + "/team?from=2026-10-01&to=2026-10-31");
    await page.getByRole("heading", { name: "Ranking" }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
  }));
