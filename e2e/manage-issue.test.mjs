// Editing an issue on its tracker never writes what wasn't read: a list of
// people or a description that failed to load is said as such, with Retry,
// never an empty form whose Save would unassign everyone or blank the text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

const MANAGE = { assign: true, create: false, edit: true, labels: false, types: false };

/** What the reads answer once they work (the harness's Jira can't answer them itself). */
const ANSWERS = {
  "issues.assignable": [{ remoteId: "mrossi", name: "Mario Rossi", handle: null, avatarUrl: null, isMe: true }],
  "issues.description": { doc: { blocks: [], v: 1 }, text: "As it is on the tracker" },
};

/** The issue page with editing allowed, the given reads failing until `ok()` is called. */
async function withFailing(names, body) {
  const app = await start({});
  try {
    const { page } = app;
    let failing = true;
    const writes = [];
    await page.route(u => new URL(u).pathname.startsWith("/api/trpc/"), async route => {
      const path = decodeURIComponent(new URL(route.request().url()).pathname.split("/api/trpc/")[1] ?? "");
      const procs = path.split(",");
      if (procs.some(p => p === "issues.assign" || p === "issues.edit")) {
        writes.push(path);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(procs.map(() => ({ result: { data: { json: { assignees: [], key: "DEMO-101", labels: [], title: null } } } }))) });
      }
      const fails = failing && procs.some(p => names.includes(p));
      if (!fails && !procs.some(p => p === "issues.manageable" || (names.includes(p) && p in ANSWERS))) return route.continue();
      // The batch's other reads answer as the server does; only the failing ones fail.
      const res = await route.fetch();
      const json = await res.json();
      const out = procs.map((p, i) =>
        p === "issues.manageable"
          ? { result: { data: { json: MANAGE } } }
          : names.includes(p)
            ? failing
              ? { error: { json: { message: "down", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: p } } } }
              : { result: { data: { json: ANSWERS[p] } } }
            : json[i],
      );
      return route.fulfill({ status: fails ? 207 : 200, contentType: "application/json", body: JSON.stringify(out) });
    });
    await body({ ...app, ok: () => (failing = false), writes });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
}

test("assignees that couldn't be read: said, with Retry; no Save until they are", () =>
  withFailing(["issues.assignable"], async ({ page, base, ok, writes }) => {
    await page.goto(`${base}/issues/DEMO-101`);
    await page.getByRole("button", { name: "Change assignees" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("alert").waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Save" }).count(), 0, "no Save over an unread list");
    ok();
    await dialog.getByRole("button", { name: "Retry" }).click();
    await dialog.getByRole("button", { name: "Save" }).waitFor();
    assert.deepEqual(writes, []);
  }));

test("an assignee missing from the tracker's options stays assigned on Save", () =>
  withFailing([], async ({ page, base, writes }) => {
    await page.route(u => new URL(u).pathname.includes("issues.assignable"), route =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ result: { data: { json: [{ remoteId: "lbianchi", name: "Luca Bianchi", handle: null, avatarUrl: null, isMe: false }] } } }]) }),
    );
    await page.goto(`${base}/issues/DEMO-101`);
    await page.getByRole("button", { name: "Change assignees" }).first().click();
    const dialog = page.getByRole("dialog");
    // mrossi, the current assignee, isn't among the options: kept, checked.
    const kept = dialog.getByRole("checkbox", { name: /mrossi|Mario Rossi/ });
    await kept.waitFor();
    assert.equal(await kept.getAttribute("data-state"), "checked");
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(writes.length, 1);
  }));

test("a description that couldn't be read: said, with Retry; no Save that would blank it", () =>
  withFailing(["issues.description"], async ({ page, base, ok, writes }) => {
    await page.goto(`${base}/issues/DEMO-101`);
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("alert").waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Save" }).count(), 0);
    ok();
    await dialog.getByRole("button", { name: "Retry" }).click();
    await dialog.getByRole("button", { name: "Save" }).waitFor();
    assert.deepEqual(writes, []);
  }));
