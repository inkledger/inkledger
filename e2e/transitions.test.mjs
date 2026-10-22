// A transition that asks for fields: its form opens, missing ones are marked, then it goes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

async function withApp(opts, body) {
  const app = await start(opts);
  try {
    await body(app);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
}

const TRANSITIONS = [
  { id: "21", name: "Avvia", toStatus: "In corso", toCategory: "In Progress", requirements: [], executable: true, remoteUrl: "https://jira.example.it/browse/DEMO-101" },
  {
    id: "51",
    name: "Chiudi",
    toStatus: "Chiuso",
    toCategory: "Done",
    requirements: [{ id: "resolution", name: "Risoluzione", required: true, type: "choice", options: [{ id: "1", name: "Completato" }, { id: "2", name: "Non risolvibile" }] }],
    executable: true,
    remoteUrl: "https://jira.example.it/browse/DEMO-101",
  },
];

/** Jira, as the API answers it: the list, and a transition refused without its fields. */
async function fakeJiraTransitions(page, sent) {
  await page.route(/\/api\/trpc\/[^?]*issues\.transition/, async route => {
    const url = new URL(route.request().url());
    const names = decodeURIComponent(url.pathname.split("/api/trpc/")[1]).split(",");
    const input = route.request().method() === "POST" ? JSON.parse(route.request().postData() ?? "{}") : {};
    const mine = n => n === "issues.transition" || n === "issues.transitions";
    // The rest of the batch goes to the server as it is.
    let real = [];
    if (!names.every(mine)) {
      const res = await route.fetch();
      real = await res.json().catch(() => []);
    }
    const out = names.map((n, i) => {
      if (!mine(n)) return real[i];
      if (n === "issues.transitions") return { result: { data: { json: TRANSITIONS } } };
      // Batched ({"0": {json}}) or single ({json}).
      const args = (url.searchParams.has("batch") ? input[i]?.json : input.json) ?? {};
      sent.push(args);
      if (!args.fields?.resolution)
        return { error: { json: { message: "Fields don't fit the transition", code: -32600, data: { code: "BAD_REQUEST", httpStatus: 400, fields: { resolution: "required" } } } } };
      return { result: { data: { json: { moved: "DEMO-101", to: "Chiuso" } } } };
    });
    await route.fulfill({ status: out.some(o => o.error) ? 400 : 200, contentType: "application/json", body: JSON.stringify(out) });
  });
}

test("a transition asking for its resolution opens a form, marks what is missing, then moves the issue", () =>
  withApp({}, async ({ page, base }) => {
    const sent = [];
    await fakeJiraTransitions(page, sent);
    await page.goto(base + "/issues/DEMO-101");
    await page.getByRole("combobox", { name: "Change status" }).click();
    await page.getByRole("option", { name: "Chiuso" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: "Move to Chiuso" }).waitFor();
    await dialog.getByRole("button", { name: "Move" }).click();
    await dialog.getByText("Required").waitFor();
    await dialog.getByRole("combobox", { name: "Risoluzione" }).click();
    await page.getByRole("option", { name: "Completato" }).click();
    await dialog.getByRole("button", { name: "Move" }).click();
    await dialog.waitFor({ state: "detached" });
    assert.deepEqual(sent.at(-1), { key: "DEMO-101", connectionId: 1, transitionId: "51", fields: { resolution: "1" } });
  }));
