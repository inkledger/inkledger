// Planned time: on a day still to come the Dashboard plans instead of logging; a
// whole day of vacation shows on that day, apart from logged time; the plan can
// be edited and deleted. (How vacation lowers a target: api/lib/plannedTarget.test.ts.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

/** The day after tomorrow, YYYY-MM-DD, in the tests' time zone (Rome). */
function inTwoDays() {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toLocaleDateString("sv-SE", { timeZone: "Europe/Rome" });
}

test("a future day plans: vacation on the day, apart from logged time, edited and deleted", async () => {
  const app = await start();
  try {
    const { page, base, db } = app;
    const day = inTwoDays();
    await page.goto(`${base}/?period=day&from=${day}`);
    // A day still to come: the header's action plans.
    const plan = page.getByRole("button", { name: "Plan", exact: true });
    await plan.click();
    const dialog = page.getByRole("dialog", { name: "Plan time" });
    await dialog.getByRole("radio", { name: "Vacation" }).click();
    await dialog.getByLabel("Whole days").waitFor();
    assert.equal(await dialog.getByLabel("From").inputValue(), day);
    await dialog.getByRole("textbox", { name: "Note" }).fill("Family trip");
    await dialog.getByRole("button", { name: "Plan it" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByText("Planned", { exact: true }).first().waitFor();

    const rows = await db.q("SELECT kind, note, issue_key FROM planned_entries");
    assert.deepEqual(rows, [{ kind: "vacation", note: "Family trip", issue_key: null }]);
    // On its day, listed apart from the logged entries.
    const list = page.getByRole("list", { name: "Planned on this day" });
    await list.getByText("Vacation", { exact: true }).waitFor();
    await list.getByText("Family trip").waitFor();

    // Edited: the note changes, still one plan.
    await list.getByRole("button", { name: "Edit the plan" }).click();
    const edit = page.getByRole("dialog", { name: "Edit the plan" });
    await edit.getByRole("textbox", { name: "Note" }).fill("Family trip, back on Monday");
    await edit.getByRole("button", { name: "Save" }).click();
    await edit.waitFor({ state: "detached" });
    await list.getByText("Family trip, back on Monday").waitFor();
    assert.deepEqual(await db.q("SELECT note FROM planned_entries"), [{ note: "Family trip, back on Monday" }]);

    // Deleted after a confirmation.
    await list.getByRole("button", { name: "Delete the plan" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete this plan?" });
    await confirm.getByRole("button", { name: "Delete the plan" }).click();
    await confirm.waitFor({ state: "detached" });
    await page.getByText("Plan deleted").waitFor();
    await list.waitFor({ state: "detached" });
    assert.deepEqual(await db.q("SELECT count(*)::int AS n FROM planned_entries"), [{ n: 0 }]);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
