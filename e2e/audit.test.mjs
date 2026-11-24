// The audit log in the browser: a change of access shows in Settings › Audit log with what
// it changed, the chain checks, and the export downloads the events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { withApp } from "./harness.mjs";

test("a permission changed in Users is in the audit log, with its diff, and the export downloads it", () =>
  withApp({}, async ({ page, base, db, dir }) => {
    await db.q("INSERT INTO users (id, username, display_name, created_at) VALUES (2, 'luca', 'Luca Bianchi', ?)", Date.now());

    // Mario gives Luca the team report.
    await page.goto(base + "/settings/users");
    await page.getByRole("button", { name: "Actions for Luca Bianchi" }).click();
    await page.getByRole("menuitem", { name: "May manage…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: "Team time: everyone's logged hours" }).check();
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.waitFor({ state: "detached" });

    // Settings › Audit log: the change, by Mario, on Luca's account.
    await page.goto(base + "/settings/audit");
    const row = page.getByRole("row").filter({ hasText: "Changed an account's access" });
    await row.waitFor();
    assert.match(await row.innerText(), /mrossi/);
    assert.match(await row.innerText(), /Account 2/);
    await page.getByRole("status").filter({ hasText: /Chain intact/ }).waitFor();

    // Its details: the permissions before and after.
    await row.getByRole("button", { name: /^Details of event \d+$/ }).click();
    const diff = page.getByRole("row").filter({ hasText: "permissions" });
    await diff.waitFor();
    assert.match(await diff.innerText(), /viewTeamTime/);

    // Filtered to sign-ins, it isn't listed; cleared, it is again.
    await page.getByRole("combobox", { name: "What" }).click();
    await page.getByRole("option", { name: "Sign-ins" }).click();
    await page.getByText("No events here").waitFor();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await row.waitFor();

    // Export: a CSV file with the event in it.
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export CSV" }).click()]);
    assert.match(download.suggestedFilename(), /^inkledger-audit-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = readFileSync(await download.path(), "utf8");
    assert.match(csv.split("\r\n")[0], /^id,at,actorKind,actorUserId,actorLabel,action,outcome/);
    assert.match(csv, /users\.setAccess/);
    assert.doesNotMatch(csv, /password_hash|encrypted_secret/);

    // The export is itself an event, and every event went to the day's file too.
    const [exported] = await db.q("SELECT action, actor_user_id FROM audit_events WHERE action = 'audit.export'");
    assert.deepEqual(exported, { action: "audit.export", actor_user_id: 1 });
    const lines = readdirSync(join(dir, "audit")).flatMap(f => readFileSync(join(dir, "audit", f), "utf8").trim().split("\n")).map(l => JSON.parse(l));
    assert.ok(lines.some(l => l.action === "users.setAccess" && l.targetId === "2"), "the change is in the file copy");
  }));
