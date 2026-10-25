// Day, Week and Month look at the same days: switching granularity keeps the period
// that contains the date being looked at (it used to jump back to today).
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// A day in a month before this one: its week and month are never today's.
const past = (() => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 2);
  d.setDate(12);
  return d;
})();

test("Dashboard: a past day, then Week and Month, stays on that day's week and month", async () => {
  const app = await start({});
  try {
    const { page, base } = app;
    await page.goto(`${base}/?period=day&from=${key(past)}`);
    await page.getByRole("radio", { name: "Week" }).click();
    await page.waitForURL(u => new URL(u).searchParams.get("period") === "week");
    const from = new URL(page.url()).searchParams.get("from");
    assert.ok(from, "still anchored (not back to today)");
    const monday = new Date(from);
    assert.ok(Math.abs(past.getTime() - monday.getTime()) < 7 * 86_400_000, `the week of ${key(past)}: ${from}`);
    await page.getByRole("radio", { name: "Month" }).click();
    await page.waitForURL(u => new URL(u).searchParams.get("period") === "month");
    assert.equal(new URL(page.url()).searchParams.get("from")?.slice(0, 7), key(past).slice(0, 7), "the month of that day");
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});

test("Timesheet: a past week, then Month, shows that week's month", async () => {
  const app = await start({});
  try {
    const { page, base } = app;
    await page.goto(base + "/timesheet");
    await page.getByRole("button", { name: "Pick a date" }).click();
    await page.getByLabel("Go to day").fill(key(past));
    await page.keyboard.press("Escape");
    await page.getByRole("radio", { name: "Month" }).click();
    const monthName = new Intl.DateTimeFormat("en-GB", { month: "long" }).format(past);
    await page.getByRole("heading", { name: new RegExp(monthName, "i") }).first().waitFor({ timeout: 5000 });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
