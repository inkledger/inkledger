// Logging time never places a block on guesses: when the day's worklogs can't
// be read, the dialog says so and offers Retry instead of "computing" forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, trpcProcs } from "./harness.mjs";

test("Log time: the day's worklogs failing to load is said, with Retry; Log waits", async () => {
  const app = await start({});
  try {
    const { page, base } = app;
    let failing = false;
    await page.route(u => new URL(u).pathname.startsWith("/api/trpc/"), async route => {
      const procs = trpcProcs(route.request().url());
      if (!failing || !procs.includes("worklogs.list")) return route.continue();
      const json = await (await route.fetch()).json();
      const out = procs.map((p, i) => (p === "worklogs.list" ? { error: { json: { message: "down", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: p } } } } : json[i]));
      return route.fulfill({ status: 207, contentType: "application/json", body: JSON.stringify(out) });
    });
    await page.goto(`${base}/issues/DEMO-101`);
    await page.getByRole("heading", { name: /Test task number 1/ }).first().waitFor();
    // From here on, a fresh read of the day fails (the dialog asks for its own day).
    failing = true;
    await page.getByRole("button", { name: "Log time" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Time spent").fill("30m");
    // Another day than the one the page already read: a fresh read, which fails.
    const d = new Date(Date.now() - 3 * 86_400_000);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await dialog.getByLabel("Start", { exact: true }).fill(`${day}T10:00`);
    await dialog.getByRole("alert").filter({ hasText: "couldn't be read" }).waitFor();
    assert.equal(await dialog.locator("button[type=submit]").isDisabled(), true, "Log waits");
    failing = false;
    await dialog.getByRole("button", { name: "Retry" }).click();
    await dialog.getByRole("alert").filter({ hasText: "couldn't be read" }).waitFor({ state: "detached" });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
