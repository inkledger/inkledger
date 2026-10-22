// One timer, two devices: the second sees it running elsewhere at once, can
// only take it over on purpose, and the time is never counted twice. With the
// event stream cut, the page falls back to polling and says it may be behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, startTimer } from "./harness.mjs";

async function withTwoDevices(body) {
  const app = await start({});
  const errors = [...app.errors];
  try {
    const browser = app.context.browser();
    const phone = await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: "Europe/Rome", locale: "en-US" });
    await phone.addCookies(await app.context.cookies());
    const other = await phone.newPage();
    other.on("pageerror", e => errors.push(String(e)));
    await body({ ...app, other, phone });
    assert.deepEqual([...app.errors, ...errors], [], "no page errors");
  } finally {
    await app.stop();
  }
}

test("a timer started on one device shows on the other at once; taking it over moves control, not time", () =>
  withTwoDevices(async ({ page, other, base, db }) => {
    await page.goto(base + "/issues/DEMO-101");
    await other.goto(base + "/issues/DEMO-101");
    await startTimer(page, "DEMO-101");

    // The other device learns it from the event stream (well before its 15 s poll).
    const takeOver = other.getByRole("button", { name: "Take over the timer of DEMO-101" }).first();
    await takeOver.waitFor({ timeout: 4000 });
    await other.getByText(/^Running on .+ since \d\d:\d\d$/).waitFor();
    assert.equal(await other.getByRole("button", { name: "Start timer DEMO-101" }).count(), 0, "no second Play");

    await db.q("UPDATE timers SET accumulated_seconds = 600");
    await takeOver.click();
    const dialog = other.getByRole("alertdialog");
    await dialog.getByText(/nothing is counted twice/).waitFor();
    await dialog.getByRole("button", { name: "Take over" }).click();
    await other.getByRole("button", { name: "Pause timer DEMO-101" }).first().waitFor();

    // The first device is now the one watching.
    await page.getByRole("button", { name: "Take over the timer of DEMO-101" }).first().waitFor({ timeout: 4000 });
    const rows = await db.q("SELECT state, accumulated_seconds FROM timers");
    assert.equal(rows.length, 1, "one timer");
    assert.equal(rows[0].state, "running");
    assert.equal(Number(rows[0].accumulated_seconds), 600, "time kept, not restarted");

    // A reload keeps it as it is.
    await page.reload();
    await page.getByRole("button", { name: "Take over the timer of DEMO-101" }).first().waitFor();
  }));

test("without the event stream the page polls, and says it may be behind", () =>
  withTwoDevices(async ({ page, other, phone, base }) => {
    await phone.route("**/api/events", route => route.abort());
    await other.goto(base + "/issues/DEMO-101");
    await page.goto(base + "/issues/DEMO-101");
    await startTimer(page, "DEMO-101");
    await other.getByRole("button", { name: "Take over the timer of DEMO-101" }).first().waitFor({ timeout: 9000 });
    await other.getByText(/Reconnecting|Offline/).waitFor();
  }));
