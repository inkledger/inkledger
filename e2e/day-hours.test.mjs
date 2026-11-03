// The hours of a single day: the break moved, removed or the day off, on the Dashboard's
// day timeline (drag or keys, in an explicit edit mode so a click never edits) or as
// fields (phones). The holes follow the day's own hours; a closed week can't change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AXE, dayKey, lastWorkday, withApp } from "./harness.mjs";

/** The last working day: no worklogs, its holes whole (9–13 and 14–18 with lunch). */
const day = () => dayKey(lastWorkday());
const own = async (db, key) => {
  const [row] = await db.q("SELECT work_day FROM work_day_overrides WHERE user_id = 1 AND day = ?", key);
  return row ? JSON.parse(row.work_day) : null;
};
const holes = page => page.getByRole("button", { name: /^Log missing time from/ });
const sliders = page => page.getByRole("slider");
const editButton = page => page.getByRole("button", { name: "Hours of the day" });

test("a click on the timeline never edits; in edit mode the break moves by drag and keys and is saved", () =>
  withApp({ viewport: { width: 1280, height: 900 } }, async ({ page, base, db }) => {
    const key = day();
    await page.goto(`${base}/?period=day&from=${key}`);
    await holes(page).first().waitFor();
    // A click on the break (between the morning's and the afternoon's holes): nothing to move.
    const morning = await page.getByRole("button", { name: /^Log missing time from 09:00 to 13:00/ }).boundingBox();
    const afternoon = await page.getByRole("button", { name: /^Log missing time from 14:00 to 18:00/ }).boundingBox();
    await page.mouse.click((morning.x + morning.width + afternoon.x) / 2, morning.y + morning.height / 2);
    assert.equal(await sliders(page).count(), 0, "no handle outside edit mode");
    assert.equal(await page.getByRole("dialog").count(), 0, "nothing opened");

    await editButton(page).click();
    const brk = page.getByRole("slider", { name: /^Break 13:00–14:00/ });
    await brk.waitFor();
    // Keyboard: in edit mode on the break; no serious accessibility violation there (target sizes included).
    assert.match((await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) ?? "", /^Break 13:00–14:00/);
    await page.waitForTimeout(400);
    await page.evaluate(AXE);
    const violations = await page.evaluate(async () =>
      (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations
        .filter(v => v.impact === "serious" || v.impact === "critical")
        .map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join(" | ")}`)
    );
    assert.deepEqual(violations, []);
    // A press that moves under the threshold is a click: the break stays.
    const b = await brk.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 2, b.y + b.height / 2, { steps: 2 });
    await page.mouse.up();
    await page.getByRole("slider", { name: /^Break 13:00–14:00/ }).waitFor();

    // Dragged an hour later: the day's edges give the scale (9:00 → 18:00).
    const start = await page.getByRole("slider", { name: /^Start of the day/ }).boundingBox();
    const end = await page.getByRole("slider", { name: /^End of the day/ }).boundingBox();
    const perMinute = (end.x - start.x) / (9 * 60);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 60 * perMinute, b.y + b.height / 2, { steps: 10 });
    await page.mouse.up();
    const moved = page.getByRole("slider", { name: /^Break 14:00–15:00/ });
    await moved.waitFor();
    // Keys: half an hour back by arrows (5 min each).
    await moved.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
    await page.getByRole("slider", { name: /^Break 13:30–14:30/ }).waitFor();

    // Only the break moved: the work is the same, so it saves at once.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText(/^Hours of .* saved\.$/).waitFor();
    assert.deepEqual(await own(db, key), { enabled: true, start: "09:00", end: "18:00", breaks: [{ start: "13:30", end: "14:30" }] });
    assert.equal(await sliders(page).count(), 0, "edit mode left");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Hours of the day", "focus back where editing began");
    // The holes follow the day's own break.
    await page.getByRole("button", { name: /^Log missing time from 14:30 to 18:00/ }).waitFor();
    await page.getByRole("button", { name: /^Log missing time from 09:00 to 13:30/ }).waitFor();
    await page.getByText("Own hours").waitFor();
  }));

test("removing the break asks: keep the target (end at 17:00) or the hours; Undo puts it back; Escape discards", () =>
  withApp({ viewport: { width: 1280, height: 900 } }, async ({ page, base, db }) => {
    const key = day();
    await page.goto(`${base}/?period=day&from=${key}`);
    await holes(page).first().waitFor();

    // Escape: the draft goes, nothing saved.
    await editButton(page).click();
    await page.getByRole("slider", { name: /^Break 13:00–14:00/ }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    assert.equal(await sliders(page).count(), 0);
    assert.equal(await own(db, key), null);

    await editButton(page).click();
    await page.getByRole("button", { name: "Remove break 13:00–14:00" }).click();
    await page.getByText(/changes the day's work from 8/).waitFor();
    await page.getByRole("button", { name: /^Keep 8.*: end at 17:00$/ }).click();
    await page.getByText(/^Hours of .* saved\.$/).waitFor();
    assert.deepEqual(await own(db, key), { enabled: true, start: "09:00", end: "17:00", breaks: [] });
    await page.getByRole("button", { name: /^Log missing time from 09:00 to 17:00/ }).waitFor();

    await page.getByRole("button", { name: "Undo" }).click();
    for (let i = 0; i < 50 && (await own(db, key)); i++) await page.waitForTimeout(100);
    assert.equal(await own(db, key), null, "back to the week's hours");
    await page.getByRole("button", { name: /^Log missing time from 14:00 to 18:00/ }).waitFor();
  }));

test("a future day off; a closed week's hours can't change; a day's own hours shape its holes from the first paint", () =>
  withApp({ viewport: { width: 1280, height: 900 } }, async ({ page, base, db }) => {
    // A Wednesday two weeks ahead.
    const next = new Date();
    next.setDate(next.getDate() + 14);
    next.setDate(next.getDate() + ((3 - next.getDay() + 7) % 7));
    const future = dayKey(next);
    await page.goto(`${base}/?period=day&from=${future}`);
    await editButton(page).click();
    await page.getByRole("switch", { name: "Day off" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText(/^Hours of .* saved\.$/).waitFor();
    assert.equal((await own(db, future))?.enabled, false);
    await page.getByText("Non-working day.").waitFor();

    // The past day's week closed: the button says why it can't.
    const past = lastWorkday();
    const monday = new Date(past);
    monday.setDate(past.getDate() - ((past.getDay() + 6) % 7));
    await db.q("INSERT INTO week_locks (user_id, week_start, closed_at) VALUES (1, ?, 1)", dayKey(monday));
    await page.goto(`${base}/?period=day&from=${dayKey(past)}`);
    await page.getByRole("button", { name: "Hours of the day" }).and(page.locator(":disabled")).waitFor();
    await db.q("DELETE FROM week_locks");

    // A day's own hours (read with the page): its holes around its own break, never the week's.
    await db.q("INSERT INTO work_day_overrides (user_id, day, work_day, created_at) VALUES (1, ?, ?, 1)", dayKey(past), JSON.stringify({ enabled: true, start: "09:00", end: "18:00", breaks: [{ start: "15:00", end: "16:00" }] }));
    await page.goto(`${base}/?period=day&from=${dayKey(past)}`);
    await page.getByRole("button", { name: /^Log missing time from 09:00 to 15:00/ }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Log missing time from 09:00 to 13:00/ }).count(), 0);
  }));

test("a timer stopped across the break is logged as two worklogs, either side of it", () => {
  const at = (h, m = 0) => new Date(lastWorkday()).setHours(h, m, 0, 0);
  const now = Date.now();
  return withApp(
    {
      viewport: { width: 1280, height: 900 },
      // 9:00–18:00 with an hour paused for lunch: 8 h tracked, not one stretch.
      seed: db =>
        db.q(
          "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'paused', ?, 28800, ?, '', ?, ?)",
          at(9), at(18), now, now,
        ),
    },
    async ({ page, base }) => {
      // The server is read-only toward Jira: what the dialog sends is answered as the server
      // would (the server's split write is covered by the worklogs router tests).
      const sent = [];
      await page.route(/\/api\/trpc\/worklogs\.create/, async route => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        const input = body[0]?.json ?? body.json;
        sent.push(input);
        const made = { id: 900, issueKey: input.issueKey, remoteId: "wl-1", timeSpentSeconds: input.seconds, comment: "" };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body[0] ? [{ result: { data: { json: made } } }] : { result: { data: { json: made } } }) });
      });
      await page.goto(`${base}/?period=day&from=${day()}`);
      const blocks = page.getByRole("button", { name: /^DEMO-101, .* tracked and not logged yet: log it$/ });
      await blocks.first().waitFor();
      assert.equal(await blocks.count(), 2, "drawn either side of the break");
      await blocks.first().click();
      const dialog = page.getByRole("dialog", { name: "Log time on DEMO-101" });
      await dialog.getByText("Split around your break: 09:00–13:00 + 14:00–18:00.").waitFor();
      await dialog.getByRole("button", { name: "Log", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(sent.length, 1, "one write: the timer is claimed once");
      assert.equal(sent[0].seconds, 8 * 3600);
      assert.equal(sent[0].fromTimer, true);
      assert.deepEqual(
        sent[0].parts.map(p => [new Date(p.started).getTime(), p.seconds]),
        [[at(9), 4 * 3600], [at(14), 4 * 3600]],
      );
    },
  );
});

test("on a past day with its break moved, new time goes after the day's own break, never into it", () => {
  const at = (h, m = 0) => new Date(lastWorkday()).setHours(h, m, 0, 0);
  return withApp(
    {
      viewport: { width: 1280, height: 900 },
      // Lunch at 15:00 that day, worked 9:00–15:00 straight: the next 2 h start at 16:00.
      seed: async db => {
        await db.q("INSERT INTO work_day_overrides (user_id, day, work_day, created_at) VALUES (1, ?, ?, 1)", day(), JSON.stringify({ enabled: true, start: "09:00", end: "18:00", breaks: [{ start: "15:00", end: "16:00" }] }));
        await db.q("INSERT INTO worklogs (user_id, connection_id, issue_key, jira_worklog_id, started, time_spent_seconds, comment, synced_at) VALUES (1, 1, 'DEMO-101', 'w-a', ?, 21600, '', 1)", at(9));
      },
    },
    async ({ page, base }) => {
      const sent = [];
      await page.route(/\/api\/trpc\/worklogs\.create/, async route => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        const input = body[0]?.json ?? body.json;
        sent.push(input);
        const made = { id: 900, issueKey: input.issueKey, remoteId: "wl-1", timeSpentSeconds: input.seconds, comment: "" };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body[0] ? [{ result: { data: { json: made } } }] : { result: { data: { json: made } } }) });
      });
      await page.goto(`${base}/?period=day&from=${day()}`);
      await page.getByRole("button", { name: /^Log missing time from 16:00 to 18:00/ }).waitFor();
      await page.getByRole("button", { name: "Log time", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Log time" });
      await dialog.getByRole("combobox", { name: "Issue" }).click();
      await page.getByRole("option", { name: /DEMO-101/ }).first().click();
      await dialog.getByLabel("Duration", { exact: true }).fill("2h");
      await dialog.getByText("From 16:00 to 18:00").waitFor();
      await dialog.getByRole("button", { name: "Log", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(sent.length, 1);
      assert.equal(new Date(sent[0].started).getTime(), at(16), "after the day's own break (the week's would say 15:00)");
      assert.equal(sent[0].parts ?? null, null, "one piece (superjson sends undefined as null + meta)");
    },
  );
});

test("on a phone the hours are fields, at 320 px, and a refused draft can't be saved", () =>
  withApp({ viewport: { width: 320, height: 720 } }, async ({ page, base, db }) => {
    const key = day();
    await page.goto(`${base}/?period=day&from=${key}`);
    await editButton(page).click();
    const sheet = page.getByRole("dialog", { name: /^Hours of / });
    await sheet.waitFor();
    assert.equal(await sliders(page).count(), 0, "no dragging on a phone");
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 320, `no sideways scroll (${width})`);
    // Every time whole, the locale's "06:00 PM" too: no field cuts its text.
    // (a time field's scrollWidth never shows it: its width is compared with a copy's own, at width auto)
    const clipped = await sheet.locator("input[type=time]").evaluateAll(els =>
      els.filter(e => {
        const c = e.cloneNode();
        c.style.cssText = "position:absolute;width:auto;min-width:0";
        document.body.append(c);
        const own = c.getBoundingClientRect().width;
        c.remove();
        return e.getBoundingClientRect().width < own - 1;
      }).length
    );
    assert.equal(clipped, 0, "no time field cut");
    // A break past the day's end: said, and Save stays off.
    await sheet.getByLabel("Break 1 from to").fill("19:00");
    await sheet.getByRole("alert").waitFor();
    assert.equal(await sheet.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
    await sheet.getByLabel("Break 1 from", { exact: true }).fill("12:00");
    await sheet.getByLabel("Break 1 from to").fill("13:00");
    await sheet.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText(/^Hours of .* saved\.$/).waitFor();
    assert.deepEqual((await own(db, key))?.breaks, [{ start: "12:00", end: "13:00" }]);
  }));

/** Away 15:00–16:00 on the last working day, a timer running (the page's clock, not the server's). */
const awayAtThree = async ({ page, base }) => {
  await page.clock.install({ time: new Date(lastWorkday()).setHours(15, 0, 0, 0) });
  await page.goto(`${base}/?period=day&from=${day()}`);
  await editButton(page).waitFor();
  await page.clock.fastForward("01:00:00");
  const dialog = page.getByRole("dialog", { name: /^You were away/ });
  await dialog.waitFor();
  return dialog;
};
const awaySeed = now => async db => {
  await db.q(
    "INSERT INTO timers (user_id, issue_key, state, started_at, accumulated_seconds, paused_at, note, created_at, updated_at) VALUES (1, 'DEMO-101', 'running', ?, 0, NULL, '', ?, ?)",
    now - 3 * 3_600_000, now, now,
  );
  await db.q("INSERT INTO settings (user_id, idle_minutes) VALUES (1, 5) ON CONFLICT (user_id) DO UPDATE SET idle_minutes = 5");
};

test("away in the afternoon: \"It was my break\" makes it the day's break and takes it off the timer; never in a closed week", () => {
  const now = Date.now();
  return withApp({ viewport: { width: 1280, height: 900 }, seed: awaySeed(now) }, async app => {
    const { page, db } = app;
    const dialog = await awayAtThree(app);
    await dialog.getByRole("button", { name: "It was my break" }).click();
    await dialog.waitFor({ state: "detached" });
    for (let i = 0; i < 50 && !(await own(db, day())); i++) await page.waitForTimeout(100);
    assert.deepEqual((await own(db, day()))?.breaks, [{ start: "15:00", end: "16:00" }], "lunch moved to the time away");
    const [timer] = await db.q("SELECT started_at FROM timers WHERE issue_key = 'DEMO-101'");
    assert.ok(Number(timer.started_at) >= now - 2 * 3_600_000 - 60_000, "the hour away left the timer");
  });
});

test("away inside the day's own break: \"It was my break\" names that break, keeps the hours and only takes the time off the timer", () => {
  const now = Date.now();
  return withApp({ viewport: { width: 1280, height: 900 }, seed: awaySeed(now) }, async ({ page, base, db }) => {
    // Lunch is 13–14 (the default week): away 13:40–13:57, the timer running.
    await page.clock.install({ time: new Date(lastWorkday()).setHours(13, 40, 0, 0) });
    await page.goto(`${base}/?period=day&from=${day()}`);
    await editButton(page).waitFor();
    await page.clock.fastForward("17:00");
    const dialog = page.getByRole("dialog", { name: /^You were away/ });
    await dialog.waitFor();
    const mine = dialog.getByRole("button", { name: "It was my break" });
    assert.match(await mine.innerText(), /13:00–14:00/, "the break it falls in, never a shorter one");
    await mine.click();
    // The dialog closes once the trim is saved.
    await dialog.waitFor({ state: "detached" });
    const [after] = await db.q("SELECT started_at FROM timers WHERE issue_key = 'DEMO-101'");
    assert.ok(Number(after.started_at) >= now - 3 * 3_600_000 + 16 * 60_000, "the time away left the timer");
    assert.equal(await own(db, day()), null, "the day's hours untouched: lunch stays 13–14");
  });
});

test("a closed week: no \"It was my break\", the timer keeps its time", () => {
  const now = Date.now();
  const past = lastWorkday();
  const monday = new Date(past);
  monday.setDate(past.getDate() - ((past.getDay() + 6) % 7));
  return withApp(
    {
      viewport: { width: 1280, height: 900 },
      seed: async db => {
        await awaySeed(now)(db);
        await db.q("INSERT INTO week_locks (user_id, week_start, closed_at) VALUES (1, ?, 1)", dayKey(monday));
      },
    },
    async app => {
      const dialog = await awayAtThree(app);
      await dialog.getByRole("button", { name: /^Remove / }).waitFor();
      assert.equal(await dialog.getByRole("button", { name: "It was my break" }).count(), 0);
      await app.page.keyboard.press("Escape");
      assert.equal(await own(app.db, day()), null);
    },
  );
});

test("on a touch tablet a short break keeps a finger's grip to move it, its edges a finger's grip each beside it", () =>
  withApp(
    {
      viewport: { width: 820, height: 1180 },
      userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      seed: db => db.q("INSERT INTO work_day_overrides (user_id, day, work_day, created_at) VALUES (1, ?, ?, 1)", day(), JSON.stringify({ enabled: true, start: "09:00", end: "18:00", breaks: [{ start: "11:00", end: "11:10" }, { start: "13:00", end: "14:00" }] })),
    },
    async ({ page, base }) => {
      await page.goto(`${base}/?period=day&from=${day()}`);
      await editButton(page).click();
      const box = name => page.getByRole("slider", { name }).boundingBox();
      const move = await box(/^Break 11:00–11:10/);
      const from = await box(/^Start of the break, 11:00/);
      const to = await box(/^End of the break, 11:10/);
      for (const b of [move, from, to]) assert.ok(b.width >= 44, `a finger wide (${b.width})`);
      assert.ok(from.x + from.width <= move.x + 1 && move.x + move.width <= to.x + 1, "side by side, none over another");
    }
  ));
