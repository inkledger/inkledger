// The board works on a bucket or one tracker, in three layouts, and a card
// goes only where its own tracker can take it: other columns stay off while
// dragging, a drop the tracker refuses goes back with its reason.
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

let github = 0;
const seed = async db => {
  const now = Date.now();
  await db.q("UPDATE issues SET status = 'In corso', category = 'doing' WHERE key = 'DEMO-102'");
  await db.q("UPDATE issues SET status = 'Fatto', category = 'done' WHERE key = 'DEMO-103'");
  await db.q("UPDATE issues SET category = 'todo' WHERE status = 'To Do'");
  [{ id: github }] = await db.q(
    "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) VALUES (1, 'github', 'Side projects', 'https://api.github.com', '4242', 'Mario Rossi', '{}', 'x', ?) RETURNING id",
    now,
  );
  const gh = (id, n, title, state, category) =>
    db.q(
      `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
       VALUES (1, ?, ?, ?, ?, ?, 'To Do', ?, 'acme/web', 'acme/web', 'Issue', '', '[]', '4242', ?, ?)`,
      github, id, `acme/web#${n}`, title, state, category, `https://github.com/acme/web/issues/${n}`, now,
    );
  await gh("I_1", 1, "Login fails on Safari", "open", "todo");
  await gh("I_2", 2, "Old crash", "closed", "done");
};

/** Each tracker's ways on, as their APIs give them; a move to "In corso" refused by Jira's validator. */
async function fakeTrackers(page, sent) {
  await page.route(/\/api\/trpc\/[^?]*issues\.transition/, async route => {
    const url = new URL(route.request().url());
    const names = decodeURIComponent(url.pathname.split("/api/trpc/")[1]).split(",");
    const batched = url.searchParams.has("batch");
    const body = route.request().method() === "POST" ? JSON.parse(route.request().postData() ?? "{}") : JSON.parse(url.searchParams.get("input") ?? "{}");
    const mine = n => n === "issues.transition" || n === "issues.transitions";
    let real = [];
    if (!names.every(mine)) {
      // The page may be closing (end of the test): nothing left to answer.
      const res = await route.fetch().catch(() => null);
      if (!res) return;
      real = await res.json().catch(() => []);
    }
    const out = names.map((n, i) => {
      if (!mine(n)) return real[i];
      const args = (batched ? body[i]?.json : body.json) ?? {};
      if (n === "issues.transitions") {
        const ways = args.connectionId === 1 ? [{ toStatus: "In corso", toCategory: "doing" }] : [{ toStatus: "closed", toCategory: "done" }];
        return { result: { data: { json: ways.map((w, j) => ({ id: String(j), name: w.toStatus, ...w, requirements: [], executable: true, remoteUrl: null })) } } };
      }
      sent.push(args);
      return { error: { json: { message: "Workflow validator: an estimate is needed first", code: -32600, data: { code: "BAD_REQUEST", httpStatus: 400 } } } };
    });
    await route.fulfill({ status: out.some(o => o?.error) ? 400 : 200, contentType: "application/json", body: JSON.stringify(out) }).catch(() => {});
  });
}

/** Drags a card by hand, to look at the columns while it is in the air. */
async function lift(page, card) {
  await card.hover();
  await page.mouse.down();
  const box = await card.boundingBox();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 30, { steps: 5 });
}

test("lanes per tracker, one tab each: while dragging only the statuses its workflow reaches take the card; a refused move goes back with its reason", () =>
  withApp({ seed }, async ({ page, base }) => {
    const sent = [];
    await fakeTrackers(page, sent);
    await page.addInitScript(() => localStorage.setItem("ikl-board-mode", "lanes"));
    await page.goto(base + "/board");
    const jira = page.locator('[data-lane="1"]');
    await jira.waitFor();
    const card = page.locator("[draggable=true]").filter({ has: page.getByText("Test task number 1", { exact: true }) });
    await card.hover();
    await page.waitForTimeout(300);
    await lift(page, card);
    const inCorso = jira.getByRole("region", { name: "In corso" });
    await page.waitForFunction(() => document.querySelector('section[aria-label="In corso"]')?.getAttribute("data-drop") === "on");
    assert.equal(await jira.getByRole("region", { name: "Fatto" }).getAttribute("data-drop"), "off");
    await page.mouse.move(...(await center(jira.getByRole("region", { name: "Fatto" }))), { steps: 5 });
    await page.mouse.up();
    assert.equal(sent.length, 0, "nothing sent for a column it can't go to");

    await lift(page, card);
    await page.mouse.move(...(await center(inCorso)), { steps: 5 });
    await page.mouse.up();
    await page.getByText("Workflow validator: an estimate is needed first").waitFor();
    assert.deepEqual(sent.map(s => [s.key, s.connectionId, s.toStatus]), [["DEMO-101", 1, "In corso"]]);
    // Back where it was.
    await jira.getByRole("region", { name: "To Do" }).getByText("Test task number 1", { exact: true }).waitFor();

    // The other tracker behind its tab, the whole height; remembered on this device.
    const tabs = page.getByRole("tablist", { name: "Trackers" });
    assert.deepEqual((await tabs.getByRole("tab").allInnerTexts()).map(x => x.replace(/\s+/g, " ").trim()).length, 2);
    await tabs.getByRole("tab", { name: /Side projects/ }).click();
    const side = page.getByRole("tabpanel", { name: "Side projects" });
    await side.getByText("Login fails on Safari").waitFor();
    assert.equal(await page.getByText("Test task number 1", { exact: true }).count(), 0);
    await page.reload();
    await page.getByRole("tabpanel", { name: "Side projects" }).getByText("Login fails on Safari").waitFor();
    // Arrows move between the tabs.
    await page.getByRole("tab", { name: /Side projects/ }).focus();
    await page.keyboard.press("ArrowLeft");
    await page.locator('[data-lane="1"]').getByText("Test task number 1", { exact: true }).waitFor();
  }));

test("a column collapses and stays collapsed after a reload", () =>
  withApp({ seed }, async ({ page, base }) => {
    await page.addInitScript(() => localStorage.setItem("ikl-board-mode", "lanes"));
    await page.goto(base + "/board");
    const jira = page.locator('[data-lane="1"]');
    await jira.getByRole("button", { name: "Collapse Fatto" }).click();
    await jira.getByRole("region", { name: "Fatto (collapsed)" }).waitFor();
    await page.reload();
    await page.locator('[data-lane="1"]').getByRole("region", { name: "Fatto (collapsed)" }).waitFor();
    await page.locator('[data-lane="1"]').getByRole("button", { name: /^Expand Fatto/ }).click();
    await page.locator('[data-lane="1"]').getByRole("region", { name: "Fatto", exact: true }).waitFor();
  }));

test("two columns collapsed in a row both stay collapsed, whatever order their saves reach the server", () =>
  withApp({ seed }, async ({ page, base }) => {
    await page.addInitScript(() => localStorage.setItem("ikl-board-mode", "lanes"));
    await page.goto(base + "/board");
    const lane = page.locator('[data-lane="1"]');
    await lane.getByRole("button", { name: "Collapse Fatto" }).waitFor();
    // The first save held on its way: a later one could reach the server before it.
    let release = () => {};
    const held = new Promise(r => (release = r));
    let seen = 0;
    let first = () => {};
    const firstSent = new Promise(r => (first = r));
    await page.route(u => new URL(u).pathname.startsWith("/api/trpc/") && new URL(u).pathname.includes("settings.update"), async route => {
      if (seen++ === 0) {
        first();
        await held;
      }
      return route.continue();
    });
    await lane.getByRole("button", { name: "Collapse Fatto" }).click();
    await firstSent;
    await lane.getByRole("button", { name: "Collapse In corso" }).click();
    await page.waitForTimeout(500);
    release();
    await page.waitForTimeout(1500);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.reload();
    await page.locator('[data-lane="1"]').getByRole("region", { name: "Fatto (collapsed)" }).waitFor();
    await page.locator('[data-lane="1"]').getByRole("region", { name: "In corso (collapsed)" }).waitFor({ timeout: 3000 });
  }));

test("three columns collapsed in a row all stay, even when the list is read again between their saves", () =>
  withApp({ seed }, async ({ page, base }) => {
    await page.addInitScript(() => localStorage.setItem("ikl-board-mode", "lanes"));
    await page.goto(base + "/board");
    const lane = page.locator('[data-lane="1"]');
    await lane.getByRole("button", { name: "Collapse Fatto" }).waitFor();
    // The first two saves each held on their way.
    const gates = [];
    const sent = [];
    await page.route(u => new URL(u).pathname.startsWith("/api/trpc/") && new URL(u).pathname.includes("settings.update"), async route => {
      const n = sent.length;
      let open = () => {};
      const gate = n < 2 ? new Promise(r => (open = r)) : Promise.resolve();
      gates.push(open);
      sent.push(n);
      await gate;
      return route.continue();
    });
    const until = async n => {
      while (sent.length < n) await page.waitForTimeout(50);
    };
    await lane.getByRole("button", { name: "Collapse Fatto" }).click();
    await until(1);
    await lane.getByRole("button", { name: "Collapse In corso" }).click();
    // The first save goes through; the second leaves and is held; the list may be read meanwhile.
    gates[0]();
    await until(2);
    await page.waitForTimeout(800);
    await lane.getByRole("button", { name: "Collapse To Do" }).click();
    gates[1]();
    await until(3);
    await page.waitForTimeout(1500);
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.reload();
    const after = page.locator('[data-lane="1"]');
    for (const name of ["Fatto", "In corso", "To Do"]) await after.getByRole("region", { name: `${name} (collapsed)` }).waitFor({ timeout: 3000 });
  }));

test("by category, and from the card's menu (keyboard, long press): only where its tracker can take it", () =>
  withApp({ seed }, async ({ page, base }) => {
    const sent = [];
    await fakeTrackers(page, sent);
    await page.goto(base + "/board");
    await page.getByRole("radio", { name: "By category" }).click();
    const doing = page.getByRole("region", { name: "In progress" });
    await doing.waitFor();
    const card = page.locator("[draggable=true]", { hasText: "Login fails on Safari" }).first();
    await card.hover();
    await page.waitForTimeout(300);
    await lift(page, card);
    await page.waitForFunction(() => document.querySelector('section[aria-label="Done"]')?.getAttribute("data-drop") === "on");
    assert.equal(await doing.getAttribute("data-drop"), "off");
    await page.mouse.up();
    // The menu lists only "Done" for the GitHub card.
    await page.getByRole("button", { name: /acme\/web#1/ }).click();
    const items = await page.getByRole("menuitem").allInnerTexts();
    assert.ok(items.includes("Done"), items.join("|"));
    assert.ok(!items.includes("In progress"), items.join("|"));
    await page.keyboard.press("Escape");
  }));

test("one tracker from the board's own switcher", () =>
  withApp({ seed }, async ({ page, base }) => {
    await page.goto(base + "/board");
    // Both trackers: a tab each, Jira's first.
    await page.getByRole("tab", { name: /Side projects/ }).waitFor();
    await page.getByText("Test task number 1").first().waitFor();
    await page.getByRole("button", { name: /^Board shows/ }).click();
    await page.getByRole("menuitemradio", { name: "Side projects" }).click();
    await page.waitForFunction(() => !document.body.innerText.includes("Test task number 1"));
    await page.getByText("Login fails on Safari").first().waitFor();
    // One tracker: no tabs.
    assert.equal(await page.getByRole("tablist", { name: "Trackers" }).count(), 0);
  }));

test("custom columns made in Settings → Buckets, each tracker's statuses mapped onto them", () =>
  withApp({ seed }, async ({ page, base }) => {
    const sent = [];
    await fakeTrackers(page, sent);
    await page.goto(base + "/settings/buckets");
    await page.getByRole("button", { name: "New bucket" }).click();
    const form = page.getByRole("dialog");
    await form.getByLabel("Name").fill("Work");
    // Each tracker whole (its own label, not one of its projects).
    await form.getByRole("checkbox", { name: /^jira\.example\.it · all of/ }).check();
    await form.getByRole("checkbox", { name: /^Side projects · all of/ }).check();
    await form.getByLabel("Board layout").selectOption("custom");
    await form.getByRole("button", { name: "Add column" }).click();
    await form.getByRole("button", { name: "Add column" }).click();
    await form.getByLabel("Name of column 1").fill("Waiting");
    await form.getByLabel("Name of column 2").fill("Finished");
    await form.getByLabel("Column for To Do").selectOption({ label: "Waiting" });
    await form.getByLabel("Column for open").selectOption({ label: "Waiting" });
    await form.getByLabel("Column for closed").selectOption({ label: "Finished" });
    await form.getByLabel("Column for Fatto").selectOption({ label: "Finished" });
    await form.getByRole("button", { name: "Save" }).click();
    await page.getByText("Work saved").waitFor();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: /Showing: Everything/ }).click();
    const switched = page.waitForResponse(r => r.url().includes("buckets.setActive"));
    await page.getByRole("menuitemradio", { name: "Work" }).click();
    await switched;

    await page.goto(base + "/board");
    const waiting = page.getByRole("region", { name: "Waiting" });
    await waiting.getByText("Login fails on Safari").waitFor();
    await waiting.getByText("Test task number 1", { exact: true }).waitFor();
    await page.getByRole("region", { name: "Finished" }).getByText("Old crash").waitFor();
    // "In corso" is in no column: said apart.
    await page.getByRole("region", { name: "In no column" }).getByText("Test task number 2", { exact: true }).waitFor();
    // GitHub's open issue can go to Finished (closed), Jira's To Do can't (only "In corso", in no column).
    const gh = page.locator("[draggable=true]").filter({ hasText: "Login fails on Safari" });
    await gh.hover();
    await page.waitForTimeout(300);
    await lift(page, gh);
    await page.waitForFunction(() => document.querySelector('section[aria-label="Finished"]')?.getAttribute("data-drop") === "on");
    await page.mouse.up();
    const jira = page.locator("[draggable=true]").filter({ has: page.getByText("Test task number 1", { exact: true }) });
    await jira.hover();
    await page.waitForTimeout(300);
    await lift(page, jira);
    await page.waitForFunction(() => document.querySelector('section[aria-label="Finished"]')?.getAttribute("data-drop") === "off");
    await page.mouse.up();
  }));

async function center(locator) {
  const b = await locator.boundingBox();
  return [b.x + b.width / 2, b.y + Math.min(b.height / 2, 60)];
}

test("a tracker that answers but has no issues for the user still has its tab, saying so", () =>
  withApp(
    {
      seed: async db => {
        await seed(db);
        await db.q(
          "INSERT INTO connections (user_id, type, label, base_url, remote_account_id, display_name, options, encrypted_secret, status, created_at) VALUES (1, 'gitlab', 'Work GitLab', 'https://git.example.com', '77', 'Mario Rossi', '{}', 'x', 'ok', ?)",
          Date.now(),
        );
      },
    },
    async ({ page, base }) => {
      await page.addInitScript(() => localStorage.setItem("ikl-board-mode", "lanes"));
      await page.goto(base + "/board");
      const tabs = page.getByRole("tablist", { name: "Trackers" });
      await tabs.getByRole("tab", { name: /Work GitLab/ }).click();
      await page.getByRole("tabpanel", { name: "Work GitLab" }).getByText("Connected: nothing for you on Work GitLab yet").waitFor();
      assert.equal(await tabs.getByRole("tab").count(), 3);
    },
  ));

let pinBoard = 0;
test("the pinboard counts what it shows: the tracker chosen on the board narrows its notes and its count alike", () =>
  withApp(
    {
      seed: async db => {
        await seed(db);
        const now = Date.now();
        const [{ id: board }] = await db.q("INSERT INTO pinboards (user_id, name, position, created_at) VALUES (1, 'Main', 0, ?) RETURNING id", now);
        pinBoard = board;
        const pin = (key, connectionId, x) =>
          db.q(
            "INSERT INTO pinboard_notes (user_id, board_id, issue_key, connection_id, note, x, y, z, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, 40, ?, ?, ?)",
            board, key, connectionId, key ? "" : "free note", x, x, now, now,
          );
        await pin("DEMO-101", 1, 40);
        await pin("acme/web#1", github, 260);
        await pin(null, null, 480);
      },
    },
    async ({ page, base }) => {
      await page.addInitScript(id => {
        localStorage.setItem("ikl-pinboard-panel", "closed");
        localStorage.setItem("ikl-pinboard-board", String(id));
      }, pinBoard);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(base + "/board");
      await page.getByRole("button", { name: "Open the pinboard (3 notes)" }).waitFor();
      await page.getByRole("button", { name: /^Board shows/ }).click();
      await page.getByRole("menuitemradio", { name: "Side projects" }).click();
      const rail = page.getByRole("button", { name: "Open the pinboard (2 notes)" });
      await rail.waitFor();
      await rail.click();
      // The free note and the GitHub issue; Jira's is off the board with its tracker.
      await page.getByText("free note").waitFor();
      await page.getByText("acme/web#1").first().waitFor();
      assert.equal(await page.locator(".paper-board").getByText("DEMO-101").count(), 0);
    },
  ));

test("under a bucket, the pinboard switcher leaves other buckets' boards out and says what the filter hides", () =>
  withApp(
    {
      seed: async db => {
        await seed(db);
        const now = Date.now();
        const bucket = async name => (await db.q("INSERT INTO buckets (user_id, name, position, query, created_at) VALUES (1, ?, 0, '', ?) RETURNING id", name, now))[0].id;
        const side = await bucket("Side");
        const jira = await bucket("Jira work");
        await db.q("INSERT INTO bucket_sources (bucket_id, connection_id) VALUES (?, ?), (?, 1)", side, github, jira);
        const board = async (name, bucketId, position) =>
          (await db.q("INSERT INTO pinboards (user_id, name, position, bucket_id, created_at) VALUES (1, ?, ?, ?, ?) RETURNING id", name, position, bucketId, now))[0].id;
        pinBoard = await board("Main", null, 0);
        await board("Sprint", jira, 1);
        await board("Weekend", side, 2);
        const pin = (key, connectionId, x) =>
          db.q(
            "INSERT INTO pinboard_notes (user_id, board_id, issue_key, connection_id, note, x, y, z, created_at, updated_at) VALUES (1, ?, ?, ?, '', ?, 40, ?, ?, ?)",
            pinBoard, key, connectionId, x, x, now, now,
          );
        await pin("DEMO-101", 1, 40);
        await pin("acme/web#1", github, 260);
      },
    },
    async ({ page, base }) => {
      await page.addInitScript(id => {
        localStorage.setItem("ikl-pinboard-panel", "open");
        localStorage.setItem("ikl-pinboard-board", String(id));
      }, pinBoard);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(base + "/board");
      await page.getByRole("button", { name: /^Board shows/ }).click();
      await page.getByRole("menuitemradio", { name: "Side", exact: true }).click();
      await page.getByText("1 note hidden: outside “Side”").waitFor();
      await page.getByRole("button", { name: /^Pinboard: Main/ }).click();
      const menu = page.getByRole("menu");
      await menu.getByText("In “Side”").waitFor();
      await menu.getByRole("menuitem", { name: /Weekend/ }).waitFor();
      await menu.getByText("For every bucket").waitFor();
      await menu.getByRole("menuitem", { name: /Main\s*All/ }).waitFor();
      assert.equal(await menu.getByRole("menuitem", { name: /Sprint/ }).count(), 0, "another bucket's board stays out");
      await page.keyboard.press("Escape");
    },
  ));

test("Belongs to: a board moved between buckets lands in the right group, its notes stay its own, another tab's bucket switch follows", () =>
  withApp(
    {
      seed: async db => {
        await seed(db);
        const now = Date.now();
        const bucket = async name => (await db.q("INSERT INTO buckets (user_id, name, position, query, created_at) VALUES (1, ?, 0, '', ?) RETURNING id", name, now))[0].id;
        const side = await bucket("Side");
        const jira = await bucket("Jira work");
        await db.q("INSERT INTO bucket_sources (bucket_id, connection_id) VALUES (?, ?), (?, 1)", side, github, jira);
        const board = async (name, bucketId, position) =>
          (await db.q("INSERT INTO pinboards (user_id, name, position, bucket_id, created_at) VALUES (1, ?, ?, ?, ?) RETURNING id", name, position, bucketId, now))[0].id;
        pinBoard = await board("Main", null, 0);
        await board("Sprint", jira, 1);
        const weekend = await board("Weekend", side, 2);
        const note = (boardId, text, x) =>
          db.q("INSERT INTO pinboard_notes (user_id, board_id, note, x, y, z, created_at, updated_at) VALUES (1, ?, ?, ?, 40, ?, ?, ?)", boardId, text, x, x, now, now);
        await note(pinBoard, "main note", 40);
        await note(weekend, "weekend note", 40);
      },
    },
    async ({ page, base }) => {
      await page.addInitScript(id => {
        localStorage.setItem("ikl-pinboard-panel", "open");
        if (!localStorage.getItem("ikl-pinboard-board")) localStorage.setItem("ikl-pinboard-board", String(id));
      }, pinBoard);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(base + "/board");
      await page.getByRole("button", { name: /^Board shows/ }).click();
      await page.getByRole("menuitemradio", { name: "Side", exact: true }).click();
      const board = page.locator(".paper-board");
      await board.getByText("main note").waitFor();
      const menu = page.getByRole("menu");
      const scope = async to => {
        await page.getByRole("button", { name: /^Pinboard: Main/ }).click();
        await menu.getByRole("menuitem", { name: "Belongs to" }).click();
        await page.getByRole("menuitemradio", { name: to, exact: true }).click();
      };
      // Main into this bucket: it joins "In “Side”" and leaves "For every bucket".
      await scope("Side");
      await page.getByText("“Main” now belongs to “Side”").waitFor();
      await page.getByRole("button", { name: /^Pinboard: Main/ }).click();
      await menu.getByText("In “Side”").waitFor();
      await menu.getByRole("menuitem", { name: /Main/ }).waitFor();
      await menu.getByRole("menuitem", { name: /Weekend/ }).waitFor();
      assert.match(await menu.innerText(), /^In “Side”\nMain\n1\nWeekend\n1\nFor every bucket\n(?!Main)/);
      assert.equal(await menu.getByRole("menuitem", { name: /^Main/ }).count(), 1);
      await page.keyboard.press("Escape");
      // Main into another bucket: it leaves, another board shows with its own notes, for good.
      await scope("Jira work");
      await page.getByText("“Main” now belongs to “Jira work”").waitFor();
      const switcher = page.getByRole("button", { name: /^Pinboard: (?!Main)/ });
      await switcher.waitFor();
      await page.waitForTimeout(800);
      assert.equal(await board.getByText("main note").count(), 0, "no other board's notes under this one");
      await switcher.click();
      assert.equal(await menu.getByRole("menuitem", { name: /^Main/ }).count(), 0);
      await menu.getByRole("menuitem", { name: /^Weekend/ }).click();
      await board.getByText("weekend note").waitFor();
      // Another tab of this device switches the bucket: this one follows, groups and all.
      const other = await page.context().newPage();
      await other.setViewportSize({ width: 1440, height: 900 });
      await other.goto(base + "/board");
      await other.getByRole("button", { name: /^Board shows/ }).click();
      await other.getByRole("menuitemradio", { name: "Jira work", exact: true }).click();
      await other.getByRole("button", { name: /^Board shows/ }).waitFor();
      await other.close();
      const followed = page.getByRole("button", { name: /^Pinboard: (?!Weekend)/ });
      await followed.waitFor({ timeout: 5000 });
      assert.equal(await board.getByText("weekend note").count(), 0);
      await followed.click();
      await menu.getByText("In “Jira work”").waitFor();
      await menu.getByRole("menuitem", { name: /^Main/ }).waitFor();
      await menu.getByRole("menuitem", { name: /Sprint/ }).waitFor();
      assert.equal(await menu.getByText("No pinboard of this bucket yet").count(), 0);
      assert.equal(await menu.getByRole("menuitem", { name: /Weekend/ }).count(), 0);
      await page.keyboard.press("Escape");
    },
  ));

test("the priority filter: several levels at once, Italian names without a rank too, kept in the URL", () =>
  withApp(
    {
      seed: async db => {
        await db.q("UPDATE issues SET priority_rank = 0 WHERE key = 'DEMO-101'");
        await db.q("UPDATE issues SET priority = 'Alta', priority_rank = NULL WHERE key = 'DEMO-102'");
        await db.q("UPDATE issues SET priority = 'Bassa', priority_rank = NULL WHERE key = 'DEMO-103'");
        await db.q("UPDATE issues SET priority = '' WHERE key = 'DEMO-104'");
      },
    },
    async ({ page, base }) => {
      await page.goto(base + "/board");
      const cards = page.locator("[draggable=true]");
      await cards.filter({ hasText: "DEMO-110" }).first().waitFor();
      const shown = async () => (await cards.allTextContents()).map(x => /(DEMO|SHOP)-\d+/.exec(x)?.[0]).filter(Boolean).sort();
      await page.getByRole("button", { name: "Filter by priority" }).click();
      const highest = page.getByRole("menuitemcheckbox", { name: /^Highest/ });
      assert.match(await highest.textContent(), /1$/);
      await highest.click();
      // The menu stays open for a second level.
      await page.getByRole("menuitemcheckbox", { name: /^High\b/ }).click();
      await page.keyboard.press("Escape");
      await page.waitForURL(/prio=0%2C1|prio=0,1/);
      assert.deepEqual(await shown(), ["DEMO-101", "DEMO-102"]);
      await page.reload();
      await cards.filter({ hasText: "DEMO-101" }).first().waitFor();
      assert.deepEqual(await shown(), ["DEMO-101", "DEMO-102"]);
      // None and Low: the issue without a priority, the Italian "Bassa".
      await page.goto(base + "/board?prio=none,3");
      await cards.filter({ hasText: "DEMO-103" }).first().waitFor();
      assert.deepEqual(await shown(), ["DEMO-103", "DEMO-104"]);
      // Nothing left with a search: said, and one click shows every priority again.
      await page.getByRole("searchbox", { name: "Search the board" }).fill("number 7");
      await page.getByText("No issue with these priorities").waitFor();
      await page.getByRole("button", { name: "Show all" }).click();
      await cards.filter({ hasText: "DEMO-107" }).first().waitFor();
      assert.deepEqual(await shown(), ["DEMO-107"]);
    },
  ));

test("a long column draws its first cards and the rest on request (the board stays light)", () =>
  withApp(
    {
      seed: async db => {
        const now = Date.now();
        for (let i = 1; i <= 120; i++) {
          await db.q(
            `INSERT INTO issues (user_id, connection_id, jira_id, key, summary, status, status_category, category, project_key, project_name, issue_type, priority, labels, assignee_id, url, synced_at)
             VALUES (1, 1, ?, ?, ?, 'To Do', 'To Do', 'todo', 'LONG', 'Long', 'Task', 'Medium', '[]', 'mrossi', ?, ?)`,
            `L-${i}`, `LONG-${i}`, `Long column card ${i}`, `https://jira.example.it/browse/LONG-${i}`, now,
          );
        }
      },
    },
    async ({ page, base }) => {
      await page.goto(base + "/board");
      const column = page.getByRole("region", { name: "To Do" }).first();
      await column.getByText("Long column card", { exact: false }).first().waitFor();
      const cards = () => column.getByText(/^Long column card \d+$/).count();
      assert.ok((await cards()) <= 50, `at most 50 drawn at first (${await cards()})`);
      await column.getByRole("button", { name: /^Show \d+ more$/ }).click();
      await page.waitForTimeout(300);
      assert.ok((await cards()) > 50, "more on request");
    },
  ));

test("a column's + opens the catalogue on that column: its status, done ones included from a done column", () =>
  withApp({ seed }, async ({ page, base }) => {
    await page.goto(base + "/board");
    const done = page.getByRole("region", { name: "Fatto" }).first();
    await done.waitFor();
    await done.getByRole("link", { name: /Fatto/ }).click();
    await page.waitForURL(/\/issues\?/);
    const params = new URL(page.url()).searchParams;
    assert.equal(params.get("done"), "1", "done ones included");
    assert.equal(params.get("status"), "Fatto");
  }));
