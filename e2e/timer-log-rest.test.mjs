// A stopped timer logged shorter than it ran: the rest used to stay paused, drawn
// as a hatched "to log" block after the entry, and the day's next start was
// offered only after it. Now the dialog says what is left and drops it unless
// asked to keep it. The time can also be given as an end time instead of a
// duration (one or the other, never kept in sync).
import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromMidnight, withApp } from "./harness.mjs";

const MINUTE = 60_000;
// Time kept here (a GitHub connection): logged with no tracker to write to, as a read-only test server must.
const KEY = "acme/web#1";
const pad = n => String(n).padStart(2, "0");
const localInput = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A GitHub issue with its timer running for the last 40 minutes. */
const seed = async db => {
  const now = Date.now();
  await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 0) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 0");
  const [{ id: github }] = await db.q(
    "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side projects', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
    now,
  );
  await db.q(
    `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
     VALUES (1, ?, 'I_1', ?, 'Task 1', 'Open', 'To Do', 'todo', 'acme/web', 'acme/web', 'Issue', '', '[]', '4242', 'https://github.com/acme/web/issues/1', ?)`,
    github, KEY, now,
  );
  await db.q(
    "INSERT INTO timers (user_id, connection_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, ?, ?, 'running', ?, 0, NULL, '', ?, ?)",
    github, KEY, now - 40 * MINUTE, now, now,
  );
};

async function stopAndOpen(page, base) {
  await page.goto(`${base}/`);
  await page.getByRole("button", { name: `Stop and log time on ${KEY}` }).first().click();
  const dialog = page.getByRole("dialog", { name: `Log time on ${KEY}` });
  await dialog.waitFor();
  return dialog;
}

const pendingBlock = page => page.getByRole("button", { name: new RegExp(`^${KEY.replace(/[/#]/g, "\\$&")}, .* tracked and not logged yet: log it$`) });

test("logged shorter, the rest is dropped by default: nothing left on the timeline", { timeout: 600_000 }, async () => {
  await awayFromMidnight(5 * MINUTE, 45 * MINUTE);
  await withApp({ seed }, async ({ page, base, db }) => {
    const dialog = await stopAndOpen(page, base);
    await dialog.getByLabel("Time spent", { exact: true }).fill("25m");
    await dialog.getByText(/^1[45] min left on the timer$/).waitFor();
    const rest = dialog.getByRole("radiogroup", { name: "What to do with the rest" });
    assert.equal(await rest.getByRole("radio", { name: "Discard" }).getAttribute("aria-checked"), "true", "dropped unless asked");
    await dialog.getByRole("button", { name: "Log", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(await db.q("SELECT issue_key FROM timers"), [], "the timer goes with its rest");
    const [row] = await db.q("SELECT time_spent_seconds FROM worklogs WHERE issue_key = ?", KEY);
    assert.equal(row.time_spent_seconds, 25 * 60);
    await page.reload();
    // The day as read out: the entry, and nothing of the timer still to log.
    const caption = page.locator('section[data-workspace-anchor="dashboard.timeline"] figcaption');
    await caption.filter({ hasText: `${KEY} from` }).waitFor({ state: "attached" });
    assert.doesNotMatch((await caption.textContent()) ?? "", /stopped, to log/);
    assert.equal(await pendingBlock(page).count(), 0, "no hatched block after the entry");
  });
});

test("logged shorter, keeping the rest: it stays to log later", { timeout: 600_000 }, async () => {
  await awayFromMidnight(5 * MINUTE, 45 * MINUTE);
  await withApp({ seed }, async ({ page, base, db }) => {
    const dialog = await stopAndOpen(page, base);
    await dialog.getByLabel("Time spent", { exact: true }).fill("25m");
    await dialog.getByRole("radiogroup", { name: "What to do with the rest" }).getByRole("radio", { name: "Keep to log later" }).click();
    await dialog.getByRole("button", { name: "Log", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const [t] = await db.q("SELECT state, accumulated_seconds FROM timers WHERE issue_key = ?", KEY);
    assert.equal(t.state, "paused");
    assert.ok(t.accumulated_seconds >= 14 * 60 && t.accumulated_seconds <= 16 * 60, `about 15 min kept, got ${t.accumulated_seconds}`);
    await pendingBlock(page).first().waitFor();
  });
});

test("by end time: the entry runs from the start to the end typed, no duration to keep in sync", { timeout: 600_000 }, async () => {
  await awayFromMidnight(5 * MINUTE, 45 * MINUTE);
  await withApp({ seed }, async ({ page, base, db }) => {
    const dialog = await stopAndOpen(page, base);
    await dialog.getByRole("radiogroup", { name: "Time as" }).getByRole("radio", { name: "End time" }).click();
    const start = new Date(await dialog.getByLabel("Start", { exact: true }).inputValue()).getTime();
    assert.ok(Number.isFinite(start), "the start is kept from the block as placed");
    // The end field opens on the block's own end; an end before the start is refused.
    await dialog.getByLabel("End", { exact: true }).fill(localInput(start - MINUTE));
    await dialog.getByText("The end must come after the start.").waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Log", exact: true }).isDisabled(), true);
    await dialog.getByLabel("End", { exact: true }).fill(localInput(start + 30 * MINUTE));
    await dialog.getByText("= 30m").waitFor();
    await dialog.getByRole("button", { name: "Log", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    const [row] = await db.q("SELECT started, time_spent_seconds FROM worklogs WHERE issue_key = ?", KEY);
    assert.equal(Number(row.started), start);
    assert.equal(row.time_spent_seconds, 30 * 60);
    assert.deepEqual(await db.q("SELECT issue_key FROM timers"), [], "the 10 min left are dropped");
  });
});
