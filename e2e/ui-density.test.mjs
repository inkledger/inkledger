// UI density audit (docs/work/ui-density.md): regressions found by the measured audit (B0) and fixed in BF0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { holdRoute, lastWorkday, withApp } from "./harness.mjs";

/** A running timer and three favourites: the sidebar at its fullest. */
async function fullSidebar(db) {
  const now = Date.now();
  await db.q("UPDATE issues SET favorite = 1 WHERE key IN ('DEMO-101', 'DEMO-102', 'DEMO-103')");
  await db.q(
    "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
    now - 25 * 60_000, now, now,
  );
}

const ready = async page => {
  await page.locator("[data-surface-stage]").waitFor();
  await page.waitForTimeout(800);
};

test("the quick stats card carries the Dashboard's anchor on the Dashboard alone", async () => {
  await withApp({}, async ({ page, base }) => {
    await page.goto(base + "/");
    await ready(page);
    assert.equal(await page.locator('[data-workspace-anchor="dashboard.stats"]').count(), 1, "Dashboard");
    for (const route of ["/timesheet", "/reports", "/issues", "/issues/DEMO-101"]) {
      await page.goto(base + route);
      await ready(page);
      assert.equal(await page.locator('[data-workspace-anchor="dashboard.stats"]').count(), 0, route);
    }
  });
});

test("the Dashboard's quick stats name their own period, whatever week is shown", async () => {
  await withApp({}, async ({ page, base }) => {
    await page.goto(base + "/?period=week&from=2026-01-05");
    await ready(page);
    const card = page.locator('[data-workspace-anchor="dashboard.stats"]');
    await card.getByText("This week", { exact: true }).waitFor();
    await card.getByText("This month", { exact: true }).waitFor();
  });
});

for (const [width, height] of [[1280, 800], [1024, 768], [1440, 900]]) {
  test(`the sidebar never draws one row over another, nor cuts one, at ${width}×${height}`, async () => {
    await withApp({ viewport: { width, height }, seed: fullSidebar }, async ({ page, base }) => {
      await page.goto(base + "/");
      await ready(page);
      const result = await page.evaluate(() => {
        const aside = document.querySelector("aside");
        const box = aside.getBoundingClientRect();
        // What shows of an element: its box cut by every ancestor that clips (a scrolling list, the sidebar).
        const rect = e => {
          let { left, top, right, bottom } = e.getBoundingClientRect();
          for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
            const s = getComputedStyle(a);
            if (s.overflowX === "visible" && s.overflowY === "visible") continue;
            const c = a.getBoundingClientRect();
            left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom);
          }
          return { left, top, right, bottom };
        };
        const visible = e => { const r = rect(e); return r.right - r.left > 1 && r.bottom - r.top > 1; };
        // Every control and favourite: none on top of another, none wider than the sidebar.
        const rows = [...aside.querySelectorAll("a[href], button, input, [role=switch]")].filter(visible).filter(e => !e.closest("[data-overflow-ok]"));
        const overlaps = [];
        for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
          const a = rect(rows[i]), b = rect(rows[j]);
          if (rows[i].contains(rows[j]) || rows[j].contains(rows[i])) continue;
          // A button laid on its own row on purpose (the pin on Board, Play on a favourite): absolute, same row box.
          const near = (x, y) => x.parentElement === y.parentElement || x.parentElement?.parentElement === y.parentElement || y.parentElement?.parentElement === x.parentElement;
          if ([rows[i], rows[j]].some(e => getComputedStyle(e).position === "absolute") && near(rows[i], rows[j])) continue;
          const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ix > 2 && iy > 2) overlaps.push(`${(rows[i].getAttribute("aria-label") || rows[i].textContent || "").trim().slice(0, 30)} / ${(rows[j].getAttribute("aria-label") || rows[j].textContent || "").trim().slice(0, 30)}`);
        }
        // Unclipped box: a row wider than the sidebar is cut by it.
        const wide = rows.filter(e => e.getBoundingClientRect().right > box.right + 1).map(e => (e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.textContent || "").trim().slice(0, 40));
        // The last row (Collapse) reachable: inside the sidebar, or the sidebar scrolls to it.
        const collapse = [...aside.querySelectorAll("button")].find(b => /^(Collapse|Expand)/.test(b.getAttribute("aria-label") || b.textContent.trim()));
        collapse?.scrollIntoView({ block: "nearest" });
        const c = collapse?.getBoundingClientRect();
        return { overlaps, wide, collapseInside: !!c && c.top >= box.top - 1 && c.bottom <= box.bottom + 1 };
      });
      assert.deepEqual(result.overlaps, [], "rows drawn over one another");
      assert.deepEqual(result.wide, [], "rows wider than the sidebar");
      assert.ok(result.collapseInside, "Collapse cut off");
    });
  });
}

test("the Desk and Team time entries of the sidebar are counted like the others", async () => {
  await withApp({}, async ({ page, base }) => {
    await page.goto(base + "/");
    await ready(page);
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    assert.equal(await nav.locator('a[href="/issues/desk"]').getAttribute("data-workspace-control"), "shell.nav.desk");
    const team = nav.locator('a[href="/team"]');
    if (await team.count()) assert.equal(await team.getAttribute("data-workspace-control"), "shell.nav.team");
  });
});

/** Every event stored so far, its payload read. */
async function flowEvents(db) {
  return (await db.q("SELECT surface_id, payload FROM workspace_flow_events")).map(row => ({ surface: row.surface_id, ...JSON.parse(row.payload) }));
}

async function waitForEvent(db, match) {
  for (let i = 0; i < 100; i++) {
    const found = (await flowEvents(db)).find(match);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`no such event: ${match}`);
}

/** An hour logged today: Reports then shows its detail and its grouping. */
async function loggedToday(db) {
  const now = Date.now();
  await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, time_spent_seconds, started, comment, synced_at) VALUES (1, 1, 'DEMO-101', 'audit-1', 3600, ?, '', ?)", now - 2 * 3600_000, now);
}

test("FlowMap counts the observed pages as their own, and hotkeys as keyboard use", { timeout: 180_000 }, async () => {
  await withApp({ seed: loggedToday }, async ({ page, base, db }) => {
    await db.q("INSERT INTO workspace_flow_settings (user_id, enabled, updated_at) VALUES (1, true, ?)", Date.now());
    const presented = page.waitForResponse(response => response.url().includes("workspace.get") && response.url().includes("reports"));
    // The sidebar's own scope too: the hotkey below is the sidebar's control, counted by its collector.
    const shell = page.waitForResponse(response => response.url().includes("workspace.get") && response.url().includes("shell-desktop"));
    // The collector's code loads after the page: a click before it would be held, but lost if the page is left first.
    const collector = page.waitForResponse(response => /\/assets\/collector-[\w-]+\.js$/.test(new URL(response.url()).pathname));
    await page.goto(base + "/reports");
    await Promise.all([presented, shell, collector]);
    await ready(page);
    // A control of the page: Reports' own surface, from the pointer.
    await page.getByRole("radio", { name: /^Issue/ }).click();
    // A hotkey: "t" stands for the sidebar's Start timer, used from the keyboard.
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("t");
    await page.waitForTimeout(400);
    await page.keyboard.press("Escape");
    // What leaving the page does (pagehide: every collector sends its queue), with the page still alive: a beacon
    // sent while the page navigates away is sometimes cut off in headless Chromium (net::ERR_ABORTED).
    const sent = page.waitForResponse(response => response.url().includes("flowMap.ingest"));
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    await sent;
    const group = await waitForEvent(db, event => event.controlId === "reports.groupBy.issue");
    assert.equal(group.surface, "reports");
    assert.equal(group.kind, "control.activate");
    const key = await waitForEvent(db, event => event.controlId === "shell.quickStart.open");
    assert.equal(key.modality, "keyboard");
    assert.equal(key.cell, undefined, "no spot for a key");
    // The page was seen as Reports, never as the Dashboard's stats.
    const events = await flowEvents(db);
    assert.ok(events.some(event => event.surface === "reports" && event.kind === "surface.view"), "Reports viewed");
    assert.equal(events.filter(event => event.anchorId === "dashboard.stats").length, 0, "no Dashboard block counted off the Dashboard");
  });
});

/** Forty more issues of mine: a list that scrolls under the sticky header and filters. */
async function longList(db) {
  const now = Date.now();
  for (let i = 1; i <= 40; i++) {
    const key = `LONG-${i}`;
    await db.q(
      `INSERT INTO issues (user_id, jira_id, key, summary, status, status_category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at, favorite)
       VALUES (1, ?, ?, ?, 'To Do', 'To Do', 'LONG', 'Long', 'Task', 'Medium', '[]', 'me', ?, ?, 0)`,
      key, key, `Row number ${i}`, `https://jira.example.it/browse/${key}`, now,
    );
  }
}

test("the row chosen with the keyboard is never left under the sticky header and filters", { timeout: 180_000 }, async () => {
  await withApp({ viewport: { width: 1280, height: 800 }, seed: longList }, async ({ page, base }) => {
    await page.goto(base + "/issues");
    await ready(page);
    await page.locator("main tbody tr").nth(10).waitFor();
    await page.locator("main").click({ position: { x: 5, y: 200 } });
    const covered = [];
    const step = async key => {
      await page.keyboard.press(key);
      await page.waitForTimeout(120);
      const r = await page.evaluate(() => {
        const row = document.querySelector("main [data-issue-id][aria-selected=true], main [data-issue-id][data-selected=true]");
        if (!row) return null;
        const box = row.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + Math.min(box.width / 2, 40), Math.max(0, box.top) + 1);
        return { top: Math.round(box.top), covered: !!hit && !row.contains(hit) };
      });
      if (r?.covered) covered.push(`${key}@${r.top}`);
      return r;
    };
    for (let i = 0; i < 25; i++) await step("j");
    for (let i = 0; i < 25; i++) await step("k");
    assert.ok((await step("j")) !== null, "a row is selected");
    assert.deepEqual(covered, [], "steps where the selected row sat under a bar");
  });
});

test("another week loading never shows as an empty week, nor as days under goal", { timeout: 180_000 }, async () => {
  await withApp({ seed: loggedToday }, async ({ page, base }) => {
    await page.goto(base + "/timesheet");
    await ready(page);
    await page.getByRole("heading", { name: "Days" }).waitFor();
    // The next week's worklogs held back: what the page shows meanwhile.
    const held = await holdRoute(page, url => url.pathname.includes("worklogs.list"));
    await page.getByRole("button", { name: /^Next/ }).first().click();
    await page.waitForTimeout(600);
    const meanwhile = await page.evaluate(() => ({
      empty: /No time this week/.test(document.querySelector("main")?.innerText ?? ""),
      busy: document.querySelectorAll('main [aria-busy="true"]').length,
      underGoal: [...document.querySelectorAll("main dt")].find(dt => dt.textContent?.trim() === "Under goal")?.nextElementSibling?.textContent?.trim() ?? null,
    }));
    held.release();
    assert.equal(meanwhile.empty, false, "no empty week while it loads");
    assert.ok(meanwhile.busy >= 2, "summary and days said busy");
    assert.equal(meanwhile.underGoal, "—", "no under-goal count made of another week's days");
  });
});

test("the Play on the open hole stays whole in the timeline right after the day starts", { timeout: 180_000 }, async () => {
  await withApp({ viewport: { width: 1280, height: 800 } }, async ({ page, base }) => {
    // Three minutes into a working day with nothing logged: the open hole is a sliver at the track's left edge.
    await page.clock.install({ time: new Date(lastWorkday()).setHours(9, 3, 0, 0) });
    await page.goto(base + "/?period=day");
    const play = page.getByRole("button", { name: /^Start a timer: from/ });
    await play.waitFor();
    const { button, clip } = await play.evaluate(el => {
      let track = el.parentElement;
      while (track && getComputedStyle(track).overflow === "visible") track = track.parentElement;
      const r = el.getBoundingClientRect(), c = track.getBoundingClientRect();
      return { button: { left: r.left, right: r.right }, clip: { left: c.left, right: c.right } };
    });
    assert.ok(button.left >= clip.left - 0.5, `cut on the left: ${button.left} < ${clip.left}`);
    assert.ok(button.right <= clip.right + 0.5, `cut on the right: ${button.right} > ${clip.right}`);
  });
});
