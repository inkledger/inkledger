// A read that fails is said where its data is drawn, with Retry: never an old
// list shown as if current, never an empty dialog as if there were nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

/** Fails the named procedures inside their batches while `on()` says so; the rest is the real server. */
async function failing(page, names, on) {
  await page.route(u => new URL(u).pathname.startsWith("/api/trpc/"), async route => {
    const procs = decodeURIComponent(new URL(route.request().url()).pathname.split("/api/trpc/")[1] ?? "").split(",");
    if (!on() || !procs.some(p => names.includes(p))) return route.continue();
    const res = await route.fetch().catch(() => null);
    if (!res) return;
    const json = await res.json().catch(() => []);
    const out = procs.map((p, i) => (names.includes(p) ? { error: { json: { message: "down", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: p } } } } : json[i]));
    return route.fulfill({ status: 207, contentType: "application/json", body: JSON.stringify(out) }).catch(() => {});
  });
}

test("Issues: a refresh that fails says the list may be out of date, with Retry", async () => {
  const app = await start({});
  try {
    const { page, base } = app;
    let down = false;
    await failing(page, ["issues.list"], () => down);
    await page.goto(`${base}/issues`);
    await page.getByText("Test task number 1", { exact: true }).first().waitFor();
    down = true;
    // Something that refreshes this very list (a favorite toggled): its rows stay on screen.
    await page.getByRole("button", { name: "Add DEMO-102 to favorites" }).first().click();
    const alert = page.getByRole("alert").filter({ hasText: "out of date" });
    await alert.waitFor();
    down = false;
    await alert.getByRole("button", { name: "Retry" }).click();
    await alert.waitFor({ state: "detached" });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});

test("Recently deleted: a list that couldn't be read is said, with Retry (not 'nothing deleted')", async () => {
  const app = await start({});
  try {
    const { page, base } = app;
    let down = true;
    await failing(page, ["worklogs.trash"], () => down);
    await page.goto(`${base}/timesheet`);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Recently deleted" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("alert").waitFor();
    down = false;
    await dialog.getByRole("button", { name: "Retry" }).click();
    await dialog.getByRole("alert").waitFor({ state: "detached" });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});

test("a dialog taller than a short screen scrolls: its last action stays reachable", async () => {
  const app = await start({
    viewport: { width: 1000, height: 420 },
    seed: async db => {
      for (let i = 0; i < 14; i++) {
        await db.q(
          "INSERT INTO worklog_trash (user_id, connection_id, worklog_uuid, issue_key, started, time_spent_seconds, comment, remote_id, reason, deleted_at) SELECT 1, id, gen_random_uuid(), 'DEMO-101', ?, 1800, ?, ?, 'user', ? FROM connections LIMIT 1",
          Date.now() - (i + 1) * 3_600_000, `entry ${i}`, `w-${i}`, Date.now(),
        );
      }
    },
  });
  try {
    const { page, base } = app;
    await page.goto(`${base}/timesheet`);
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Recently deleted" }).click();
    const dialog = page.getByRole("dialog");
    const last = dialog.getByRole("button", { name: "Restore" }).last();
    await last.waitFor();
    await last.scrollIntoViewIfNeeded();
    const box = await last.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 420, `the last Restore is on screen (y ${box?.y})`);
    const top = await dialog.boundingBox();
    assert.ok(top && top.y >= 0, "the dialog's top is on screen");
  } finally {
    await app.stop();
  }
});
