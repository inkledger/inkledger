// A team lead (E3): the team report shows only the people of the teams it leads, read
// only; nobody else's time, no accounts to manage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp } from "./harness.mjs";

const OCTOBER = "/team?from=2026-10-01&to=2026-10-31";
const at = (day, hour) => new Date(2026, 9, day, hour).getTime();

/** Mario (signed in) leads "Apps" with Giulia in it; Luca is in no team of his. */
async function seedLead(db) {
  const now = Date.now();
  await db.q("UPDATE users SET role = 'member', role_id = NULL, permissions = '[]' WHERE id = 1");
  for (const [id, name] of [[2, "Giulia Bianchi"], [3, "Luca Verdi"]]) {
    await db.q("INSERT INTO users (id, username, role, display_name, created_at) VALUES (?, ?, 'member', ?, ?)", id, `u${id}`, name, now);
    await db.q("INSERT INTO connections (id, user_id, type, base_url, remote_account_id, options, encrypted_secret, created_at) VALUES (?, ?, 'jira', 'https://jira.example.it', ?, '{}', 'x', ?)", id, id, `u${id}`, now);
    await db.q("INSERT INTO connection_sync (connection_id, stream, last_ok_at) VALUES (?, 'worklogs', ?)", id, now);
    for (const d of [5, 6, 7]) {
      await db.q(
        "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (?, ?, 'APP-1', ?, ?, ?, ?)",
        id, id, `w${id}-${d}`, 8 * 3600, at(d, 9), now,
      );
    }
  }
  const [{ id: team }] = await db.q("INSERT INTO teams (name, created_at) VALUES ('Apps', ?) RETURNING id", now);
  await db.q("INSERT INTO team_members (team_id, user_id, role) VALUES (?, 1, 'lead'), (?, 2, 'member')", team, team);
  await db.q("INSERT INTO role_assignments (user_id, role_id, team_id) SELECT 1, id, ? FROM roles WHERE key = 'team-lead'", team);
}

const rowNames = page => page.getByRole("table").locator("tbody th").allInnerTexts();

test("a team lead sees its team's people only, read only", () =>
  withApp({ seed: seedLead }, async ({ page, base }) => {
    await page.goto(base + OCTOBER);
    const table = page.getByRole("table", { name: "Hours by person and day" });
    await table.waitFor();
    await table.getByRole("button", { name: /^Giulia Bianchi · Mon 5 Oct/ }).waitFor();
    const names = (await rowNames(page)).join(" | ");
    assert.match(names, /Giulia Bianchi/);
    assert.match(names, /Mario Rossi/);
    assert.doesNotMatch(names, /Luca Verdi/, "someone outside the team isn't listed");

    // Giulia's day opens read only: her worklog drawn, nothing to follow or change.
    await table.getByRole("button", { name: /^Giulia Bianchi · Mon 5 Oct/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: /Giulia Bianchi · Monday 5 October/ }).waitFor();
    assert.equal(await dialog.getByRole("link").count(), 0, "someone else's issue is not a link");
    await page.keyboard.press("Escape");

    // Luca's time, asked for directly, is as good as not there.
    const status = await page.evaluate(async () => {
      const input = encodeURIComponent(JSON.stringify({ json: { userId: 3, day: "2026-10-05" } }));
      return (await fetch(`/api/trpc/team.day?input=${input}`)).status;
    });
    assert.equal(status, 404);

    // Leading a team manages nothing: no accounts, no Teams in Settings.
    await page.goto(base + "/settings/users");
    assert.equal(await page.getByRole("button", { name: "Invite someone" }).count(), 0);
    assert.equal(await page.getByRole("link", { name: /^Teams/ }).count(), 0);
  }));

test("Settings › Teams: an owner makes a team, adds someone and makes them its lead", () =>
  withApp({ seed: async db => db.q("INSERT INTO users (id, username, role, display_name, created_at) VALUES (2, 'giulia', 'member', 'Giulia Bianchi', ?)", Date.now()) }, async ({ page, base, db }) => {
    await page.goto(base + "/settings/teams");
    await page.getByRole("button", { name: "New team" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Team name").fill("Apps");
    await dialog.getByRole("button", { name: "Create" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("combobox", { name: "Add someone to Apps" }).click();
    await page.getByRole("option", { name: "Giulia Bianchi" }).click();
    await page.getByRole("button", { name: "Actions for Giulia Bianchi in Apps" }).click();
    await page.getByRole("menuitem", { name: "Make lead" }).click();
    await page.getByText("Lead", { exact: true }).waitFor();
    const leads = await db.q("SELECT ra.user_id, r.key FROM role_assignments ra JOIN roles r ON r.id = ra.role_id WHERE ra.team_id IS NOT NULL");
    assert.deepEqual(leads, [{ user_id: 2, key: "team-lead" }], "the lead holds the team-lead role in the team");
    // Users shows the team on her row.
    await page.goto(base + "/settings/users");
    await page.getByText("Apps · Lead").waitFor();
  }));
