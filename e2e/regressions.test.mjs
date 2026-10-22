// Targeted browser tests for interactions that broke before. Each test runs
// the production bundle on its own temporary DB (harness.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP, fakeProcedures, mockNative, start } from "./harness.mjs";

const note = (db, text, x, y) => {
  const now = Date.now();
  return db.q(
    "INSERT INTO pinboard_notes (user_id, board_id, issue_key, note, color, x, y, rotation, z, created_at, updated_at) VALUES (1, 1, NULL, ?, 'yellow', ?, ?, 1, 1, ?, ?)",
    text, x, y, now, now,
  );
};

/** Runs `body` against a fresh app, always stopping it. */
async function withApp(opts, body) {
  const app = await start(opts);
  try {
    await body(app);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
}

async function openPinboard(page, base) {
  await page.addInitScript(() => localStorage.setItem("ikl-pinboard-panel", "open"));
  await page.goto(base + "/board");
  const board = page.getByRole("region", { name: "Pinboard" });
  await board.locator("[data-postit]").first().waitFor();
  await page.waitForTimeout(300);
  return board;
}

test("an issue card dropped on the pinboard becomes a post-it", () =>
  withApp({ seed: db => note(db, "reminder", 60, 60) }, async ({ page, base, db }) => {
    const board = await openPinboard(page, base);
    const card = page.locator("div[draggable]").filter({ hasText: "DEMO-105" }).first();
    await card.dragTo(board.getByLabel(/^Pinboard area/), { targetPosition: { x: 260, y: 300 } });
    await page.waitForTimeout(500);
    const [pinned] = await db.q("SELECT board_id FROM pinboard_notes WHERE issue_key = 'DEMO-105'");
    assert.equal(pinned?.board_id, 1);
  }));

test("a private note from the issue page hangs on the pinboard, tied by a red string that follows a drag", () =>
  withApp({}, async ({ page, base, db }) => {
    await page.goto(base + "/issues/DEMO-105");
    const notes = page.locator("[data-private-notes]");
    await notes.getByLabel("New private note").fill("Ask Luca about the budget");
    await notes.getByRole("button", { name: "Add note" }).click();
    const item = notes.locator("[data-private-note]").first();
    await item.getByText("Ask Luca about the budget").waitFor();
    const [saved] = await db.q("SELECT issue_key, body FROM issue_notes");
    assert.deepEqual(saved, { issue_key: "DEMO-105", body: "Ask Luca about the budget" });
    await item.getByRole("button", { name: /Hang the note/ }).click();
    await item.getByText(/^On /).waitFor();

    const board = await openPinboard(page, base);
    const hung = board.getByRole("group", { name: /^Private note on DEMO-105/ });
    await hung.waitFor();
    const string = board.locator("[data-pinboard-strings] .pin-string");
    assert.equal(await string.count(), 1, "one red string");
    const before = await string.getAttribute("d");
    // Dragging the issue's post-it: the string follows while it moves.
    const issue = board.getByRole("group", { name: /^Note DEMO-105/ });
    const box = await issue.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 30);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height + 60, { steps: 6 });
    const during = await string.getAttribute("d");
    assert.notEqual(during, before, "the string moves with the drag");
    await page.mouse.up();

    // Deleting the note on the issue page takes its post-it off the board.
    const [{ id }] = await db.q("SELECT id FROM issue_notes");
    await page.goto(base + "/issues/DEMO-105");
    await page.locator(`[data-private-note="${id}"]`).getByRole("button", { name: "Delete the note" }).click();
    await page.waitForTimeout(400);
    const left = await db.q("SELECT count(*)::int AS n FROM pinboard_notes WHERE issue_note_id IS NOT NULL");
    assert.equal(left[0].n, 0);
  }));

test("the pinboard has no scrollbars and pans by dragging its background", () =>
  withApp({ seed: async db => { await note(db, "near", 40, 40); await note(db, "far", 1300, 80); } }, async ({ page, base }) => {
    const board = await openPinboard(page, base);
    const area = board.getByLabel(/^Pinboard area/);
    assert.equal(await area.evaluate(el => el.offsetWidth - el.clientWidth), 0, "no vertical scrollbar");
    assert.equal(await area.evaluate(el => el.offsetHeight - el.clientHeight), 0, "no horizontal scrollbar");
    // A pill tells there is a note to the right; it brings it in view.
    await board.getByRole("button", { name: /note to the right/ }).click();
    await page.waitForTimeout(700);
    const before = await area.evaluate(el => el.scrollLeft);
    assert.ok(before > 0, "pill scrolled to the note");
    const box = await area.boundingBox();
    await page.mouse.move(box.x + box.width - 40, box.y + box.height - 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width + 160, box.y + box.height - 40, { steps: 6 });
    await page.mouse.up();
    const after = await area.evaluate(el => el.scrollLeft);
    assert.ok(before - after > 150, `panned left (${before} → ${after})`);
  }));

test("on a narrow window the pinboard sheet has one close button, and it closes", () =>
  withApp({ viewport: { width: 520, height: 800 } }, async ({ page, base }) => {
    await page.goto(base + "/board");
    await page.getByRole("button", { name: /pinboard/i }).first().click();
    const sheet = page.getByRole("dialog");
    await sheet.waitFor();
    assert.equal(await sheet.getByRole("button", { name: /^Close/ }).count(), 1);
    await sheet.getByRole("button", { name: "Close the pinboard" }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole("dialog").count(), 0);
  }));

test("the sidebar pin opens the pinboard as a dialog from any page", () =>
  withApp({ seed: db => note(db, "reminder", 60, 60) }, async ({ page, base }) => {
    await page.goto(base + "/issues");
    await page.getByRole("button", { name: "Open the pinboard" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("region", { name: "Pinboard" }).locator("[data-postit]").first().waitFor();
    assert.equal(await page.getByRole("region", { name: "Pinboard" }).count(), 1, "mounted once");
    assert.equal(await dialog.getByRole("button", { name: "Widen the pinboard" }).count(), 0);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole("dialog").count(), 0);
    await page.keyboard.press("p");
    await dialog.getByRole("region", { name: "Pinboard" }).waitFor();
    await dialog.getByRole("button", { name: "Close the pinboard" }).click();
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole("dialog").count(), 0);
  }));

test("on the Board, the sidebar pin and P toggle its own panel, not a dialog", () =>
  withApp({}, async ({ page, base }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("seeded")) {
        sessionStorage.setItem("seeded", "1");
        localStorage.setItem("ikl-pinboard-panel", "closed");
      }
    });
    await page.goto(base + "/board");
    await page.getByRole("heading", { name: "Board" }).first().waitFor();
    await page.keyboard.press("p");
    await page.getByRole("region", { name: "Pinboard" }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("ikl-pinboard-panel")), "open");
    const pin = page.getByRole("button", { name: "Open the pinboard" });
    assert.equal(await pin.getAttribute("aria-pressed"), "true");
    await pin.click();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => localStorage.getItem("ikl-pinboard-panel")), "closed");
    assert.equal(await page.getByRole("region", { name: "Pinboard" }).count(), 0);
  }));

test("the collapsed rail has no pinboard pin", () =>
  withApp({}, async ({ page, base }) => {
    await page.addInitScript(() => localStorage.setItem("ikl-sidebar-collapsed", "1"));
    await page.goto(base + "/issues");
    await page.getByRole("link", { name: "Board" }).first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Open the pinboard" }).count(), 0);
  }));

test("on a narrow window More's pinboard opens the Board's pinboard sheet", () =>
  withApp({ viewport: { width: 520, height: 800 } }, async ({ page, base }) => {
    await page.goto(base + "/board");
    await page.getByRole("navigation", { name: "Quick sections" }).getByRole("button", { name: "More" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Open the pinboard" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("region", { name: "Pinboard" }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole("dialog").count(), 1, "More gave way to the pinboard");
  }));

/**
 * The last working day before today, as the Dashboard's day: its holes are there,
 * whole, at any hour and on any day the tests run (today's start at 9:00, and a
 * Saturday or Sunday has none).
 */
function lastWorkday() {
  const d = new Date();
  do d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}
const lastWorkdayKey = () => {
  const d = lastWorkday();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

test("filling a hole: click and C cut, arrows move a cut by 1 or 15 minutes", () =>
  withApp({}, async ({ page, base }) => {
    await page.goto(`${base}/?period=day&from=${lastWorkdayKey()}`);
    const hole = page.getByRole("button", { name: /Log missing time/ }).first();
    await hole.click();
    const strip = page.getByRole("group", { name: /Strip of time to log/ });
    await strip.waitFor();
    await page.waitForTimeout(500);
    const cuts = () => page.locator("[data-cut]").count();
    const box = await strip.boundingBox();
    // Far apart, so the first cut has room to move right.
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
    assert.equal(await cuts(), 1, "click cuts");
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2, { steps: 3 });
    await page.keyboard.press("c");
    assert.equal(await cuts(), 2, "C cuts where the pointer is");
    // Arrows move a cut by a minute, Shift by 15.
    const first = page.locator("[data-cut]").first();
    const minute = async () => Number(await first.getAttribute("data-cut")) / 60_000;
    await first.focus();
    const m0 = await minute();
    await page.keyboard.press("ArrowRight");
    assert.equal((await minute()) - m0, 1, "arrow: 1 minute");
    // A cut never passes its neighbour: the whole morning's hole leaves room for the jump.
    const room = (Number(await page.locator("[data-cut]").nth(1).getAttribute("data-cut")) / 60_000) - m0;
    assert.ok(room > 17, `room for a 15-minute jump (${room} min)`);
    await page.keyboard.press("Shift+ArrowRight");
    assert.equal((await minute()) - m0, 16, "shift+arrow: 15 more");
  }));

test("filling a hole: once a piece is logged, its cuts stay where they are", () =>
  withApp({}, async ({ page, base }) => {
    await fakeProcedures(page, {
      "worklogs.create": { id: 900, issueKey: "DEMO-101", remoteId: "wl-e2e", timeSpentSeconds: 600, comment: "" },
    });
    await page.goto(`${base}/?period=day&from=${lastWorkdayKey()}`);
    const hole = page.getByRole("button", { name: /Log missing time/ }).first();
    await hole.click();
    const strip = page.getByRole("group", { name: /Strip of time to log/ });
    await strip.waitFor();
    await page.waitForTimeout(500);
    const box = await strip.boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
    await page.getByRole("button", { name: /Choose the issue/ }).first().click();
    await page.keyboard.type("DEMO-101");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: /^Log/ }).last().click();
    const cut = page.locator("[data-cut]").first();
    await page.waitForFunction(() => document.querySelector("[data-cut]")?.getAttribute("aria-label")?.includes("locked"));
    const before = await cut.getAttribute("data-cut");
    await cut.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Delete");
    assert.equal(await cut.getAttribute("data-cut"), before, "the cut did not move");
    // Clicking inside the logged piece does not cut it.
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);
    assert.equal(await page.locator("[data-cut]").count(), 1);
  }));

test("filling a hole in parallel: a lane under the strip logs an overlapping span on another issue, its empty pieces are not sent", () =>
  withApp({}, async ({ page, base }) => {
    // What the sheet sends, answered as the server would.
    const sent = [];
    await page.route(/\/api\/trpc\/worklogs\.create/, async route => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      const input = body[0]?.json ?? body.json;
      sent.push(input);
      const made = { id: 900 + sent.length, issueKey: input.issueKey, remoteId: `wl-${sent.length}`, timeSpentSeconds: input.seconds, comment: "" };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body[0] ? [{ result: { data: { json: made } } }] : { result: { data: { json: made } } }) });
    });
    await page.goto(`${base}/?period=day&from=${lastWorkdayKey()}`);
    const hole = page.getByRole("button", { name: /Log missing time/ }).first();
    await hole.click();
    const strip = page.getByRole("group", { name: /Strip of time to log/ });
    await strip.waitFor();
    await page.waitForTimeout(500);
    // A lane added and taken away again leaves the hole as it was.
    await page.getByRole("button", { name: "In parallel" }).click();
    await page.getByRole("button", { name: "Remove lane" }).click();
    assert.equal(await page.getByRole("group", { name: /Parallel lane/ }).count(), 0);

    await page.getByRole("button", { name: "In parallel" }).click();
    const lane = page.getByRole("group", { name: /Parallel lane 2/ });
    await lane.waitFor();
    // The whole hole on one issue; the middle of it, at the same time, on another.
    await page.getByRole("button", { name: /^Choose the issue…/ }).first().click();
    await page.keyboard.type("DEMO-101");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    const box = await lane.boundingBox();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height / 2);
    const section = page.getByRole("region", { name: /Parallel lane 2/ });
    assert.equal(await section.getByRole("listitem").count(), 3);
    await section.getByRole("button", { name: /Choose the issue \(empty/ }).nth(1).click();
    await page.keyboard.type("DEMO-102");
    await page.waitForTimeout(300);
    await page.keyboard.press("Enter");
    await page.getByText(/in parallel$/).waitFor();
    await page.getByRole("button", { name: "Log 2 worklogs" }).click();
    await page.getByText("2 worklogs created").waitFor();
    // Only the two pieces with an issue; the parallel one inside the other, at the same time.
    assert.deepEqual(sent.map(w => w.issueKey), ["DEMO-101", "DEMO-102"]);
    const span = w => [Date.parse(w.started), Date.parse(w.started) + w.seconds * 1000];
    const [a0, a1] = span(sent[0]);
    const [b0, b1] = span(sent[1]);
    assert.ok(b0 > a0 && b1 < a1, "the parallel span lies inside the other one");
  }));

test("filling a hole by extending the worklog before or after it, never a tiny new one", () => {
  const today = h => {
    const d = lastWorkday();
    d.setHours(Math.floor(h), Math.round((h % 1) * 60), 0, 0);
    return d.getTime();
  };
  return withApp(
    {
      seed: async db => {
        await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-101', 'w-before', ?, 1800, 'morning', 1)", today(9));
        await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-102', 'w-after', ?, 1800, 'review', 1)", today(9.75));
      },
    },
    async ({ page, base }) => {
      // The hole 9:30–9:45 of the last working day (whole, whatever the time now).
      const hole = page.getByRole("button", { name: /Log missing time from 09:30 to 09:45/ });
      const sent = [];
      await page.route(/\/api\/trpc\/worklogs\.update/, async route => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        const input = body[0]?.json ?? body.json;
        sent.push(input);
        const made = { id: input.id, issueKey: "DEMO-101", timeSpentSeconds: input.seconds, comment: input.comment };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body[0] ? [{ result: { data: { json: made } } }] : { result: { data: { json: made } } }) });
      });
      await page.goto(`${base}/?period=day&from=${lastWorkdayKey()}`);
      await hole.click();
      await page.getByRole("group", { name: /Strip of time to log/ }).waitFor();
      // Both neighbours on offer; the one-click way extends the one before.
      await page.getByRole("button", { name: "Extend DEMO-102 (starts 09:45)" }).waitFor();
      await page.getByRole("button", { name: "Extend DEMO-101", exact: true }).click();
      await page.getByText("1 worklog extended").waitFor();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].seconds, 1800 + 900, "the gap added to it");
      assert.equal(Date.parse(sent[0].started), today(9), "its start kept");
      assert.equal(sent[0].comment, "morning", "its comment kept");

      // Cut in two: the first half to the one before, the second to the one after (it starts earlier).
      await page.reload();
      await hole.click();
      const strip = page.getByRole("group", { name: /Strip of time to log/ });
      await strip.waitFor();
      await page.waitForTimeout(300);
      const box = await strip.boundingBox();
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
      await page.getByRole("button", { name: "Extend DEMO-101 (ends 09:30)" }).click();
      await page.getByRole("button", { name: "Extend DEMO-102 (starts 09:45)" }).click();
      await page.getByRole("button", { name: "Log 2 worklogs" }).click();
      await page.getByText("2 worklogs extended").waitFor();
      const after = sent.at(-1);
      assert.equal(after.comment, "review");
      assert.ok(Date.parse(after.started) < today(9.75) && Date.parse(after.started) > today(9.5), "starts inside the hole");
      assert.equal(after.seconds, 1800 + (today(9.75) - Date.parse(after.started)) / 1000);
    },
  );
});

test("discarding a timer asks first: its time would be lost", () =>
  withApp(
    {
      seed: db => {
        const now = Date.now();
        return db.q(
          "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'paused', ?, 1800, ?, '', ?, ?)",
          now - 1800_000, now, now, now,
        );
      },
    },
    async ({ page, base, db }) => {
      await page.goto(base + "/issues");
      const discard = page.getByRole("button", { name: "Discard timer DEMO-101" }).first();
      await discard.click();
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      assert.equal((await db.q("SELECT id FROM timers")).length, 1, "kept after Cancel");
      await discard.click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
      await page.waitForTimeout(500);
      assert.equal((await db.q("SELECT id FROM timers")).length, 0, "gone once confirmed");
    },
  ));

test("issues: a page past the end goes back to the last one", () =>
  withApp({}, async ({ page, base }) => {
    await page.goto(base + "/issues?p=4");
    await page.getByText("DEMO-101").first().waitFor();
    await page.waitForFunction(() => !new URL(location.href).searchParams.get("p") || new URL(location.href).searchParams.get("p") === "1");
  }));

const PROFILES = base => ({
  list: [
    { url: base, name: "Dev", user: "Mario Rossi", jira: "jira.example.it" },
    { url: "http://localhost:47823", name: "Work", user: "M. Rossi", jira: "jira.acme.it" },
  ],
  active: base,
});

const NATIVE_INFO = {
  version: "0.1.0",
  platform: "macos",
  desktop: true,
  autostart: false,
  shortcuts: [{ keys: "⌥⇧T", label: "Start a timer", ok: true }, { keys: "⌥⇧P", label: "Break", ok: false }],
};

test("reports: the Days view merges each day's issues and totals the range by issue", () =>
  withApp(
    {
      seed: async db => {
        const log = (id, key, secs, day, hour) =>
          db.q(
            "INSERT INTO worklogs (user_id, issue_key, jira_worklog_id, time_spent_seconds, started, synced_at) VALUES (1, ?, ?, ?, ?, ?)",
            key, id, secs, new Date(2020, 2, day, hour).getTime(), Date.now(),
          );
        await log("r1", "DEMO-105", 3600, 2, 9);
        await log("r2", "DEMO-105", 1800, 2, 14);
        await log("r3", "DEMO-101", 2700, 2, 11);
        await log("r4", "DEMO-105", 900, 3, 10);
      },
    },
    async ({ page, base }) => {
      await page.goto(base + "/reports?from=2020-03-02&to=2020-03-03&group=days");
      const monday = page.getByRole("region", { name: /Mon.*2/ });
      await monday.getByText("1 h 30 min").waitFor();
      assert.equal(await monday.getByRole("link", { name: "DEMO-105" }).count(), 1, "one line per issue per day");
      await page.getByRole("region", { name: /Tue.*3/ }).getByRole("link", { name: "DEMO-105" }).waitFor();
      await page.getByText("Range total by issue").waitFor();
    },
  ));

test("settings: a menu of categories, one at a time, each with its URL", () =>
  withApp({}, async ({ page, base }) => {
    await page.goto(base + "/settings");
    const menu = page.getByRole("navigation", { name: "Settings categories" });
    await menu.waitFor();
    // Desktop: the first category is open next to the menu.
    await page.getByRole("heading", { name: "Account", level: 2 }).waitFor();
    // Browser: no native categories; their URL goes back to the menu.
    assert.equal(await menu.getByRole("link", { name: /Permissions/ }).count(), 0);
    await page.goto(base + "/settings/permissions");
    await page.waitForURL(u => u.pathname === "/settings");
    await menu.getByRole("link", { name: /Appearance/ }).click();
    await page.waitForURL(u => u.pathname === "/settings/appearance");
    await page.getByText("Theme and density").waitFor();
    // Search filters the menu; Enter opens the first match.
    await page.getByLabel("Search settings").fill("inactiv");
    assert.equal(await menu.getByRole("link").count(), 1);
    await page.keyboard.press("Enter");
    await page.waitForURL(u => u.pathname === "/settings/timers");
  }));

test("settings: old Italian section URLs still land on the renamed ones", () =>
  withApp({}, async ({ page, base }) => {
    await page.goto(base + "/settings/aspetto");
    await page.waitForURL(u => u.pathname === "/settings/appearance");
    await page.goto(base + "/settings/orario");
    await page.waitForURL(u => u.pathname === "/settings/schedule");
  }));

test("sidebar: sections folded before the ids were English stay folded", () =>
  withApp({}, async ({ page, base }) => {
    await page.addInitScript(() => localStorage.setItem("ikl-sidebar-sections", JSON.stringify(["Analisi"])));
    await page.goto(base + "/");
    await page.waitForFunction(() => localStorage.getItem("ikl-sidebar-sections") === '["analysis"]');
    assert.equal(await page.locator('aside a[href="/reports"]').count(), 0, "Analysis stays folded");
  }));

test("settings on a phone: the menu first, then the category with a way back", () =>
  withApp({ viewport: { width: 390, height: 800 } }, async ({ page, base }) => {
    await page.goto(base + "/settings");
    const menu = page.getByRole("navigation", { name: "Settings categories" });
    await menu.waitFor();
    assert.equal(await page.getByRole("heading", { name: "Account", level: 2 }).isVisible(), false, "no category yet");
    await menu.getByRole("link", { name: /Work schedule/ }).click();
    await page.getByRole("heading", { name: "Work schedule", level: 2 }).waitFor();
    await menu.waitFor({ state: "hidden", timeout: 3000 }); // menu hidden while reading a category
    await page.getByRole("link", { name: "Settings" }).last().click();
    await page.waitForURL(u => u.pathname === "/settings");
    await menu.waitFor({ state: "visible", timeout: 3000 });
  }));

test("settings: what is rarely needed is folded, and stays as you leave it", () =>
  withApp({}, async ({ page, base }) => {
    await page.goto(base + "/settings/schedule");
    const history = page.getByRole("button", { name: /^History/ });
    await history.waitFor();
    assert.equal(await history.getAttribute("aria-expanded"), "false");
    await history.click();
    await page.getByRole("button", { name: "Use as base" }).waitFor();
    await page.reload();
    assert.equal(await page.getByRole("button", { name: /^History/ }).getAttribute("aria-expanded"), "true");
    // The notification tester is folded too.
    await page.goto(base + "/settings/notifications");
    assert.equal(await page.getByRole("button", { name: "Test notifications" }).getAttribute("aria-expanded"), "false");
  }));

test("native app: Settings has Server and Permissions; permissions act; sign-out forgets this server", () =>
  withApp({}, async ({ page, base, context, db }) => {
    await mockNative(context, {
      native_info: NATIVE_INFO,
      list_profiles: PROFILES(base),
      notification_permission: "unknown",
    });
    await page.goto(base + "/settings/permissions");
    const section = page.locator("#permissions-system");
    await section.waitFor();
    for (const text of ["Decided by the system", "1 taken"]) {
      assert.equal(await section.getByText(text).count(), 1, text);
    }
    await section.getByRole("button", { name: /How to manage permissions on macOS/ }).click();
    await section.getByText(/System Settings → Notifications/).waitFor();
    await section.getByRole("button", { name: "Notification settings" }).click();
    // The menu shows each category's state.
    await page.getByRole("link", { name: /Permissions.*1 taken/ }).waitFor();

    await page.getByRole("link", { name: /Server/ }).click();
    await page.waitForURL(u => u.pathname === "/settings/servers");
    await page.getByRole("button", { name: "Open", exact: true }).click(); // the other profile
    await page.getByRole("button", { name: "Sign out and disconnect" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Sign out and disconnect" }).click();
    await page.waitForTimeout(800);
    const calls = await page.evaluate(() => window.__nativeCalls);
    const names = calls.map(c => c[0]);
    assert.deepEqual(calls.find(c => c[0] === "open_system_settings")?.[1], { pane: "notifications" });
    assert.deepEqual(calls.find(c => c[0] === "open_profile")?.[1], { url: "http://localhost:47823" });
    assert.ok(names.includes("forget_server"), `forget_server called (${names})`);
    assert.ok(names.includes("set_profile_info"), "the page told who is signed in");
    assert.equal((await db.q("SELECT count(*) n FROM sessions"))[0].n, 0, "session ended");
  }));

test("native app: Settings → Server adds, renames and removes servers; the one in use stays", () =>
  withApp({}, async ({ page, base, context }) => {
    await mockNative(context, { native_info: NATIVE_INFO, list_profiles: PROFILES(base) });
    await page.goto(base + "/settings/servers");
    const group = page.getByRole("region", { name: "Your servers" });
    await group.getByText("Work").waitFor();
    assert.equal(await group.getByRole("button", { name: "Remove Dev" }).count(), 0, "the server in use can't be removed");
    // Rename in place.
    await group.getByRole("button", { name: "Rename Work" }).click();
    await page.getByLabel("Name of localhost:47823").fill("Office");
    await page.keyboard.press("Enter");
    // Remove (with confirmation).
    await group.getByRole("button", { name: "Remove Work" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    // Add.
    await group.getByRole("button", { name: "Add server" }).click();
    await page.getByLabel("Name (optional)").fill("Client");
    await page.getByLabel("Address").fill("localhost:4000");
    await page.getByRole("button", { name: "Add and open" }).click();
    await page.waitForTimeout(300);
    const calls = await page.evaluate(() => window.__nativeCalls);
    const args = name => calls.find(c => c[0] === name)?.[1];
    assert.deepEqual(args("rename_profile"), { url: "http://localhost:47823", name: "Office" });
    assert.deepEqual(args("remove_profile"), { url: "http://localhost:47823" });
    assert.deepEqual(args("add_profile"), { url: "localhost:4000", name: "Client" });
  }));

test("native app: the account menu switches server profile", () =>
  withApp({}, async ({ page, base, context }) => {
    await mockNative(context, { list_profiles: PROFILES(base) });
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Account menu" }).click();
    // The profiles are right in the menu, the one in use marked and inert.
    const here = page.getByRole("menuitem", { name: /Dev/ });
    assert.equal(await here.getAttribute("aria-disabled"), "true");
    await page.getByRole("menuitem", { name: /Work/ }).click();
    const calls = await page.evaluate(() => window.__nativeCalls);
    assert.deepEqual(calls.find(c => c[0] === "open_profile")?.[1], { url: "http://localhost:47823" });
  }));

test("login: a remembered device offers 'Continue as', never re-enters by itself after 'Sign out'; profiles are one click away", () =>
  withApp({}, async ({ page, base, context }) => {
    await mockNative(context, { list_profiles: PROFILES(base) });
    // What Jira would confirm live: this device remembers Mario.
    await fakeProcedures(page, {
      "auth.remembered": { displayName: "Mario Rossi", email: "mrossi", siteUrl: "https://jira.example.it" },
    });
    const resumes = [];
    page.on("request", r => r.url().includes("auth.resume") && resumes.push(r.url()));
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    const again = page.getByRole("button", { name: "Continue as Mario Rossi" });
    await again.waitFor();
    await page.waitForTimeout(500);
    assert.equal(resumes.length, 0, "signed out on purpose: no automatic resume");
    await page.getByRole("button", { name: "Use another account" }).click();
    await page.getByLabel("Password").waitFor();
    // The other server, straight from the login page.
    await page.getByRole("navigation", { name: "Other profiles" }).getByRole("button", { name: /Work/ }).click();
    const calls = await page.evaluate(() => window.__nativeCalls);
    assert.deepEqual(calls.find(c => c[0] === "open_profile")?.[1], { url: "http://localhost:47823" });
  }));

test("language: English until Italian is picked, and the choice stays", () =>
  withApp({}, async ({ page, base }) => {
    // A first visit: no choice yet, so English.
    await page.goto(base + "/settings/appearance");
    await page.getByText("Theme and density").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), "en");
    await page.getByRole("radio", { name: "Italiano" }).or(page.getByRole("button", { name: "Italiano" })).first().click();
    await page.getByText("Tema e densità").waitFor();
    await page.reload();
    await page.getByText("Tema e densità").waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), "it");
  }));

test("native app: links to other sites open in the system browser", () =>
  withApp({}, async ({ page, base, context }) => {
    await mockNative(context);
    await page.goto(base + "/");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const a = Object.assign(document.createElement("a"), { href: "https://jira.example.it/browse/X-1", textContent: "jira" });
      document.body.append(a);
      a.click();
    });
    const calls = await page.evaluate(() => window.__nativeCalls);
    assert.ok(calls.some(([c, a]) => c === "plugin:opener|open_url" && a.url.includes("jira.example.it")));
    assert.equal(new URL(page.url()).origin, base, "the window stayed on the server");
  }));

test("native shell config: HTML drag and drop reaches the page; the page may call every command it uses", () => {
  const conf = JSON.parse(readFileSync(`${APP}src-tauri/tauri.conf.json`, "utf8"));
  for (const w of conf.app.windows) assert.equal(w.dragDropEnabled, false, `${w.label}: dragDropEnabled false`);
  // Remote pages need an explicit permission per app command (Tauri ACL).
  const bridge = readFileSync(`${APP}src/lib/native.ts`, "utf8");
  const used = [...bridge.matchAll(/invokeNative(?:<[^>]+>)?\("([a-z_]+)"/g)].map(m => m[1]);
  const remote = JSON.parse(readFileSync(`${APP}src-tauri/capabilities/remote.json`, "utf8"));
  assert.ok(used.length >= 5);
  for (const cmd of used) {
    assert.ok(remote.permissions.includes(`allow-${cmd.replaceAll("_", "-")}`), `remote may call ${cmd}`);
  }
  // The bundled profiles page: what it invokes, its capability grants.
  const page = readFileSync(`${APP}src-tauri/ui/index.html`, "utf8");
  const local = JSON.parse(readFileSync(`${APP}src-tauri/capabilities/default.json`, "utf8"));
  const pageCmds = [...new Set([...page.matchAll(/invoke\("([a-z_]+)"/g)].map(m => m[1]))];
  assert.ok(pageCmds.length >= 3);
  for (const cmd of pageCmds) {
    assert.ok(local.permissions.includes(`allow-${cmd.replaceAll("_", "-")}`), `profiles page may call ${cmd}`);
  }
});

test("native profiles page: lists profiles, errors keep the form usable, adding opens the server", () =>
  withApp({}, async ({ page, base, context }) => {
    const html = readFileSync(`${APP}src-tauri/ui/index.html`, "utf8");
    await context.route("http://tauri.test/**", r => r.fulfill({ contentType: "text/html", body: html }));
    await context.addInitScript(() => {
      if (location.host !== "tauri.test") return;
      window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd === "get_locale") return "en";
            if (cmd === "list_profiles")
              return { list: [{ url: "http://localhost:1", name: "Off", user: "Mario", jira: "jira.x.it" }], active: null };
            if (cmd === "add_profile" || cmd === "open_profile") {
              if (new URL(args.url).port === "1") throw "Server unreachable.";
              location.href = args.url;
            }
          },
        },
      };
    });
    await page.goto("http://tauri.test/index.html?change=1&from=" + encodeURIComponent("http://localhost:1"));
    await page.getByText("Mario · jira.x.it · localhost:1").waitFor();
    // Always a way back to the server we came from.
    await page.getByRole("button", { name: "Back to Off" }).waitFor();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("status").classList.contains("error"));
    assert.equal(await page.isEnabled("#go"), true, "can retry");
    await page.fill("#url", "tail1234.ts.net");
    await page.click("#go");
    assert.match(await page.textContent("#status"), /The server computer's name is missing/);
    await page.fill("#name", "Dev");
    await page.fill("#url", base.replace("http://", ""));
    await page.click("#go");
    await page.waitForURL(u => u.origin === base);
  }));

const TAILNET = { ALLOWED_HOSTS: "my-mac.tail1.ts.net,127.0.0.1,localhost" };
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";

/** Publishes a fake APK in the server's downloads folder. */
function publishApk(dir) {
  const d = join(dir, "downloads");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "inkledger.apk"), Buffer.from("PK fake apk"));
  writeFileSync(
    join(d, "manifest.json"),
    JSON.stringify({ android: { version: "0.3.0", file: "inkledger.apk", size: 11, sha256: "a".repeat(64), builtAt: Date.now() } }),
  );
}

test("desktop app: Settings → Devices shows steps and a QR to the install page on the Tailscale name", () =>
  withApp({ env: TAILNET }, async ({ page, base, context, dir }) => {
    publishApk(dir);
    // Browser: no Devices category.
    await page.goto(base + "/settings");
    const menu = page.getByRole("navigation", { name: "Settings categories" });
    await menu.waitFor();
    assert.equal(await menu.getByRole("link", { name: /Devices/ }).count(), 0);

    await mockNative(context, { native_info: NATIVE_INFO, list_profiles: PROFILES(base) });
    await page.goto(base + "/settings/devices");
    await page.getByRole("heading", { name: "Devices", level: 2 }).waitFor();
    // Opened on 127.0.0.1, the QR still points where a phone can go.
    await page.getByRole("img", { name: "QR code: https://my-mac.tail1.ts.net/install" }).waitFor();
    await page.getByText(/Version 0\.3\.0/).waitFor();
    await menu.getByRole("link", { name: /Devices.*Android 0\.3\.0/ }).waitFor();
  }));

test("About: this server's addresses and a pointer to adding devices", () =>
  withApp({ env: TAILNET }, async ({ page, base }) => {
    await page.goto(base + "/");
    await page.getByRole("link", { name: "About" }).click();
    await page.waitForURL(u => u.pathname === "/info");
    await page.getByText("https://my-mac.tail1.ts.net", { exact: true }).waitFor();
    await page.getByText("https://my-mac.tail1.ts.net/install").waitFor();
    assert.equal(await page.getByRole("img", { name: /QR code/ }).count(), 0, "the QR lives in the desktop app's settings");
  }));

test("Devices: Tailscale is set up from the app ('Use Tailscale'), then the QR points to its name", () =>
  withApp({}, async ({ page, base, context }) => {
    const port = Number(new URL(base).port);
    // Another server of this computer (the dev one) is already published: not ours.
    const ts = {
      installed: true,
      running: true,
      dnsName: "my-mac.tail1.ts.net",
      https: true,
      serves: [{ port: 3000, target: "http://127.0.0.1:3000" }],
    };
    await mockNative(context, {
      native_info: NATIVE_INFO,
      list_profiles: PROFILES(base),
      tailscale_info: ts,
      tailscale_serve: { ...ts, serves: [...ts.serves, { port, target: `http://127.0.0.1:${port}` }] },
    });
    await page.goto(base + "/settings/devices");
    const access = page.getByRole("region", { name: "How you are reached" });
    await access.getByText(/my-mac\.tail1\.ts\.net · .*:3000 → http:\/\/127\.0\.0\.1:3000/).waitFor();
    assert.equal(await page.getByRole("img", { name: /QR code: https:\/\/my-mac/ }).count(), 0, "no QR before");
    await access.getByRole("button", { name: "Use Tailscale" }).click();
    // Its own port: https://<name>:<port>, never the dev server's address.
    await page.getByRole("img", { name: `QR code: https://my-mac.tail1.ts.net:${port}/install` }).waitFor();
    const calls = await page.evaluate(() => window.__nativeCalls);
    assert.deepEqual(calls.find(c => c[0] === "tailscale_serve")?.[1], { port });
    // The user's own DNS name: added here, accepted by the server.
    await access.getByLabel("Network name").fill("ikl.home");
    await access.getByRole("button", { name: "Add" }).click();
    await access.getByText("ikl.home", { exact: true }).waitFor();
    const health = await fetch(base + "/api/health", { headers: { host: "ikl.home:47843" } });
    assert.equal(health.status, 200);
  }));

test("install page, no login: Android downloads the APK", () =>
  withApp({ env: TAILNET, userAgent: ANDROID_UA, viewport: { width: 390, height: 800 } }, async ({ page, base, context, dir }) => {
    publishApk(dir);
    await context.clearCookies();
    await page.goto(base + "/install");
    const link = page.getByRole("link", { name: "Download inkledger for Android" });
    await link.waitFor();
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    assert.equal(download.suggestedFilename(), "inkledger.apk");
    await page.getByText(new URL(base).host, { exact: true }).waitFor();
  }));

test("install page, no login: iPhone adds the web app to the Home screen", () =>
  withApp({ env: TAILNET, userAgent: IPHONE_UA, viewport: { width: 390, height: 800 } }, async ({ page, base, context }) => {
    await context.clearCookies();
    await page.goto(base + "/install");
    await page.getByText("Add to Home Screen", { exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Download inkledger for Android" }).count(), 0);
  }));

/** Many issues assigned to me: the lists and the board columns scroll. */
const manyIssues = async db => {
  const now = Date.now();
  for (let i = 200; i < 260; i++) {
    await db.q(
      `INSERT INTO issues (user_id, jira_id, key, summary, status, status_category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at, favorite)
       VALUES (1, ?, ?, ?, 'To do', 'To Do', 'DEMO', 'Project', 'Task', 'Medium', '[]', 'mrossi', ?, ?, 0)`,
      `DEMO-${i}`, `DEMO-${i}`, `Work item ${i}`, `https://jira.example.it/browse/DEMO-${i}`, now,
    );
  }
};

test("navigation: from the Board to an issue and back, with the same search and scroll", () =>
  withApp({ seed: manyIssues }, async ({ page, base }) => {
    await page.goto(base + "/board");
    await page.getByPlaceholder("Search the board…").fill("Work");
    await page.waitForURL(u => u.searchParams.get("q") === "Work");
    const col = page.locator('[data-scroll-key^="board-col-"]').first();
    await col.waitFor();
    await col.evaluate(el => (el.scrollTop = 600));
    await page.waitForTimeout(200);
    await col.getByRole("link", { name: /DEMO-2\d\d/ }).last().click();
    await page.waitForURL(u => /^\/issues\/\d+\/DEMO-/.test(u.pathname));
    // The back button says where we came from.
    await page.getByRole("button", { name: "Board", exact: true }).first().click();
    await page.waitForURL(u => u.pathname === "/board" && u.searchParams.get("q") === "Work");
    assert.equal(await page.getByPlaceholder("Search the board…").inputValue(), "Work");
    await page.waitForFunction(() => document.querySelector('[data-scroll-key^="board-col-"]')?.scrollTop > 500, null, { timeout: 3000 });
  }));

test("navigation: Issues filters and scroll come back with Alt+←", () =>
  withApp({ seed: manyIssues }, async ({ page, base }) => {
    await page.goto(base + "/issues");
    await page.getByRole("searchbox", { name: "Filter the local catalogue" }).fill("Work");
    await page.waitForURL(u => u.searchParams.get("q") === "Work");
    await page.getByRole("link", { name: "DEMO-210" }).first().waitFor();
    await page.locator("main").evaluate(el => (el.scrollTop = 400));
    await page.waitForTimeout(200);
    await page.getByRole("link", { name: "DEMO-220", exact: true }).first().click();
    await page.waitForURL(u => /^\/issues\/\d+\/DEMO-220$/.test(u.pathname));
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Alt+ArrowLeft");
    await page.waitForURL(u => u.pathname === "/issues" && u.searchParams.get("q") === "Work");
    assert.equal(await page.getByRole("searchbox", { name: "Filter the local catalogue" }).inputValue(), "Work");
    await page.waitForFunction(() => document.querySelector("main")?.scrollTop > 350, null, { timeout: 3000 });
  }));

test("navigation: the Timesheet keeps its week when you come back", () =>
  withApp({}, async ({ page, base }) => {
    await page.goto(base + "/timesheet");
    await page.getByRole("button", { name: "Previous period" }).click();
    await page.waitForURL(u => u.searchParams.has("day"));
    const week = new URL(page.url()).searchParams.get("day");
    await page.locator('aside a[href="/board"]').click();
    await page.waitForURL(u => u.pathname === "/board");
    await page.goBack();
    await page.waitForURL(u => u.pathname === "/timesheet");
    assert.equal(new URL(page.url()).searchParams.get("day"), week);
  }));

test("navigation: an issue opened directly goes back to the Issues list", () =>
  withApp({}, async ({ page, base }) => {
    await page.goto(base + "/issues/DEMO-101");
    await page.getByRole("button", { name: "Issues", exact: true }).first().click();
    await page.waitForURL(u => u.pathname === "/issues");
  }));

test("links: a blocked domain asks first, 'Always allow' opens it for good, Settings can take it back", () =>
  withApp({}, async ({ page, base, context }) => {
    await context.addInitScript(() => {
      window.__opened = [];
      window.open = url => {
        window.__opened.push(String(url));
        return null;
      };
    });
    await fakeProcedures(page, {
      "issues.description": {
        text: "Specs in the [sheet|https://docs.google.com/sheet/1] and here: https://evil.example.org/p.",
        doc: {
          v: 1,
          blocks: [
            {
              t: "p",
              c: [
                { t: "text", v: "Specs in the " },
                { t: "link", url: "https://docs.google.com/sheet/1", c: [{ t: "text", v: "sheet" }] },
                { t: "text", v: " and here: " },
                { t: "link", url: "https://evil.example.org/p", c: [{ t: "text", v: "https://evil.example.org/p" }] },
                { t: "text", v: ". " },
                { t: "link", url: "javascript:alert(1)", c: [{ t: "text", v: "bad link" }] },
              ],
            },
          ],
        },
      },
      "issues.remoteLinks": [{ id: 1, url: "https://acme.atlassian.net/wiki/x", title: "Confluence page", summary: null, app: "Confluence" }],
      "issues.attachments": [],
    });
    await page.goto(base + "/issues/DEMO-101");
    // Blocked: shown with a lock, the click asks.
    const sheet = page.getByRole("button", { name: "sheet", exact: true });
    await sheet.waitFor();
    // Only http(s)/mailto become links: a script address stays words.
    await page.getByText("bad link").waitFor();
    assert.equal(await page.getByRole("link", { name: "bad link" }).count() + (await page.getByRole("button", { name: "bad link" }).count()), 0);
    await sheet.click();
    await page.getByRole("button", { name: "Open just this once" }).click();
    assert.deepEqual(await page.evaluate(() => window.__opened), ["https://docs.google.com/sheet/1"]);
    await sheet.click();
    await page.getByRole("button", { name: "Always allow docs.google.com" }).click();
    // Allowed now: a real link.
    await page.getByRole("link", { name: "sheet", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "sheet", exact: true }).getAttribute("href"), "https://docs.google.com/sheet/1");
    // The other domain stays blocked; the remote link is listed.
    await page.getByRole("button", { name: "https://evil.example.org/p" }).waitFor();
    await page.getByText("Confluence page").waitFor();

    await page.goto(base + "/settings/links");
    await page.getByText("docs.google.com", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Remove docs.google.com" }).click();
    await page.getByText("No domains yet").waitFor();
  }));

test("desktop app: share the server on the Wi-Fi (no Tailscale): QR to the welcome page, hosts accepted by the server", () =>
  withApp({}, async ({ page, base, context, db }) => {
    const running = {
      running: true,
      target: base,
      addresses: ["https://my-mac.local:47843", "https://192.168.1.20:47843"],
      welcome: "http://192.168.1.20:47844",
      fingerprint: "AB:CD",
      error: null,
    };
    await mockNative(context, {
      native_info: NATIVE_INFO,
      list_profiles: PROFILES(base),
      lan_status: { ...running, running: false, addresses: [], welcome: null, fingerprint: null },
      lan_start: running,
    });
    await page.goto(base + "/settings/devices");
    const lan = page.getByRole("region", { name: "Local network (no Tailscale)" });
    await lan.getByRole("switch").click();
    await lan.getByRole("img", { name: "QR code: http://192.168.1.20:47844" }).waitFor();
    await lan.getByText("https://my-mac.local:47843").waitFor();
    const hosts = (await db.q("SELECT host FROM server_hosts ORDER BY host")).map(r => r.host);
    assert.deepEqual(hosts, ["192.168.1.20", "my-mac.local"]);
    const calls = await page.evaluate(() => window.__nativeCalls.map(c => c[0]));
    assert.ok(calls.includes("lan_start"));
  }));

test("install page opened on the Wi-Fi speaks of the local network, not Tailscale", () =>
  withApp({ env: { ALLOWED_HOSTS: "127.0.0.1,localhost" }, userAgent: ANDROID_UA, viewport: { width: 390, height: 800 } }, async ({ page, base, context }) => {
    // Registered as the desktop app does (signed in), then a phone without session opens it.
    await page.goto(base + "/");
    const added = await page.evaluate(async () => {
      const r = await fetch("/api/trpc/info.addHosts?batch=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 0: { json: { hosts: ["my-mac.local"] } } }),
      });
      return r.status;
    });
    assert.equal(added, 200);
    await context.clearCookies();
    // The browser asks for my-mac.local; the request goes to the test server.
    const port = new URL(base).port;
    await page.route("http://my-mac.local:" + port + "/**", async route => {
      const u = new URL(route.request().url());
      const res = await route.fetch({ url: base + u.pathname + u.search, headers: { ...route.request().headers(), host: "my-mac.local:" + port } });
      await route.fulfill({ response: res });
    });
    await page.goto("http://my-mac.local:" + port + "/install");
    await page.getByText("You're on the server's local network").waitFor();
    assert.equal(await page.getByText("Tailscale is on").count(), 0);
  }));

test("Settings → Backup: 'Back up now' writes a dump to the folder and lists it; the schedule saves", () => {
  const dir = mkdtempSync(join(tmpdir(), "ikl-e2e-backups-"));
  const bin = join(dir, "fake-pg_dump");
  // The real pg_dump runs in the container; here a stand-in writes the file.
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) echo dump > "\${a#--file=}";; esac; done\n`);
  chmodSync(bin, 0o755);
  return withApp({ env: { BACKUP_DIR: dir, PG_DUMP_BIN: bin } }, async ({ page, base }) => {
    await page.goto(base + "/settings/backup");
    await page.getByRole("heading", { name: "Backup", level: 2 }).waitFor();
    await page.getByRole("button", { name: "Back up now" }).click();
    await page.getByText(/^inkledger-\d{8}-\d{6}\.dump · /).waitFor();
    assert.equal(readdirSync(dir).filter(f => f.endsWith(".dump")).length, 1);
    await page.getByRole("radio", { name: "Weekly" }).click();
    await page.getByLabel("Day").waitFor();
    await page.getByRole("link", { name: /Backup.*at 02:00/ }).waitFor();
  });
});

const PHONE = { width: 390, height: 800 };
const pausedTimer = db => {
  const now = Date.now();
  return db.q(
    "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'paused', ?, 4500, ?, '', ?, ?)",
    now - 4500_000, now, now, now,
  );
};

test("phone: the tab bar reaches the sections, More holds the rest", () =>
  withApp({ viewport: PHONE }, async ({ page, base }) => {
    await page.goto(base + "/");
    const bar = page.getByRole("navigation", { name: "Quick sections" });
    await bar.waitFor();
    assert.equal(await page.locator("aside").isVisible(), false, "no sidebar");
    const board = bar.getByRole("link", { name: "Board", exact: true });
    await board.click();
    await page.waitForURL(u => u.pathname === "/board");
    await bar.locator('a[href="/board"][aria-current=page]').waitFor({ timeout: 3000 });
    await bar.getByRole("button", { name: "More" }).click();
    await page.getByRole("dialog").getByRole("link", { name: "Timesheet" }).click();
    await page.waitForURL(u => u.pathname === "/timesheet");
    await page.waitForTimeout(400);
    assert.equal(await page.getByRole("dialog").count(), 0, "More closes on navigating");
    await bar.locator("button[aria-current=page]", { hasText: "More" }).waitFor({ timeout: 3000 });
  }));

test("phone: tapping the tab you are on scrolls back to the top", () =>
  withApp({ viewport: PHONE }, async ({ page, base }) => {
    await page.goto(base + "/issues");
    const issues = page.getByRole("navigation", { name: "Quick sections" }).getByRole("link", { name: "Issues" });
    await issues.waitFor();
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.waitForFunction(() => window.scrollY > 0);
    await issues.click();
    await page.waitForFunction(() => window.scrollY === 0, null, { timeout: 3000 });
    assert.equal(new URL(page.url()).pathname, "/issues");
  }));

test("phone: the page's end is not hidden under the tab bar", () =>
  withApp({ viewport: PHONE }, async ({ page, base }) => {
    await page.goto(base + "/issues");
    const bar = page.getByRole("navigation", { name: "Quick sections" });
    await bar.waitFor();
    // The list first, then down to the end (again while it still grows).
    await page.getByRole("link", { name: /DEMO-1\d\d/ }).first().waitFor();
    await page.waitForFunction(async () => {
      const h = document.documentElement.scrollHeight;
      window.scrollTo(0, h);
      await new Promise(r => setTimeout(r, 150));
      return document.documentElement.scrollHeight === h;
    });
    const main = await page.locator("main").boundingBox();
    const top = (await bar.boundingBox()).y;
    assert.ok(main.y + main.height <= top + 1, JSON.stringify({ main, top }));
  }));

test("phone: the tab bar steps aside while typing", () =>
  withApp({ viewport: PHONE }, async ({ page, base }) => {
    // A touch screen, as far as the app asks.
    await page.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = q => (q === "(hover: none)" ? { matches: true, media: q, addEventListener() {}, removeEventListener() {} } : real(q));
    });
    await page.goto(base + "/issues");
    const bar = page.getByRole("navigation", { name: "Quick sections" });
    await bar.waitFor();
    const field = page.locator("main input[type=search]").first();
    await field.focus();
    await bar.waitFor({ state: "hidden", timeout: 2000 });
    await field.blur();
    await bar.waitFor({ state: "visible", timeout: 2000 });
  }));

test("phone: the center button starts a timer, or opens the timers when one exists", async () => {
  await withApp({ viewport: PHONE }, async ({ page, base }) => {
    await page.goto(base + "/");
    await page.getByRole("navigation", { name: "Quick sections" }).getByRole("button", { name: "Start timer" }).click();
    await page.getByRole("dialog").getByRole("combobox").waitFor();
  });
  await withApp({ viewport: PHONE, seed: pausedTimer }, async ({ page, base }) => {
    await page.goto(base + "/");
    const button = page.getByRole("navigation", { name: "Quick sections" }).getByRole("button", { name: /^Timer paused on DEMO-101 · 1:15:00/ });
    await button.click();
    const sheet = page.getByRole("dialog", { name: "Timers" });
    await sheet.getByRole("button", { name: "Resume timer DEMO-101" }).waitFor();
    await sheet.getByRole("button", { name: "Stop and log time on DEMO-101" }).waitFor();
    await sheet.getByRole("button", { name: "Start another" }).click();
    await page.getByRole("dialog").getByRole("combobox").waitFor();
  });
});

test("wide window: no tab bar", () =>
  withApp({}, async ({ page, base }) => {
    await page.goto(base + "/");
    await page.getByRole("navigation", { name: "Main navigation" }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "Quick sections" }).isVisible(), false);
  }));

test("a change that never reaches the server says so in the user's words, not the browser's", () =>
  withApp({}, async ({ page, base }) => {
    await page.goto(base + "/issues/DEMO-101");
    const star = page.getByRole("button", { name: "Add DEMO-101 to favorites" }).first();
    await star.waitFor();
    // The request cut on its way: the browser's own failure ("Failed to fetch").
    await page.route(u => new URL(u).pathname.includes("issues.toggleFavorite"), route => route.abort("failed"));
    await star.click();
    await page.getByText("The server can’t be reached. Check the connection and try again.").waitFor();
    assert.equal(await page.getByText(/Failed to fetch|TRPCClientError/).count(), 0, "no browser or library words");
  }));

test("Reports' bars show logged time only, never a running timer's", () =>
  withApp({
    // An hour logged today, so the trend has bars to draw.
    seed: db => {
      const nine = new Date();
      nine.setHours(9, 0, 0, 0);
      return db.q(
        "INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-102', 'w-today', ?, 3600, '', 1)",
        nine.getTime(),
      );
    },
  }, async ({ page, base }) => {
    await page.goto(base + "/issues/DEMO-101");
    await page.getByRole("button", { name: "Start timer DEMO-101" }).first().click();
    await page.getByRole("button", { name: "Pause timer DEMO-101" }).first().waitFor();
    await page.waitForTimeout(2500);
    await page.goto(base + "/reports");
    await page.getByRole("heading", { name: "Reports", level: 1 }).waitFor();
    await page.getByRole("heading", { name: "Trend" }).waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await page.locator(".stripes-pending").count(), 0, "no pending segment on Reports");
  }));
