// "Ask AI" on the Desk (docs/work/desk.md, batch 4c): the chat beside the desk, its context
// chips, a streamed answer (OLLAMA_SIMULATOR), Stop, Save as note, the model off, a phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AXE, withApp } from "./harness.mjs";

const pane = key => ({ connectionId: 1, key, remoteId: key });
const seedDesk = (keys, parked = []) => db =>
  db.q(
    "INSERT INTO desks (user_id, name, layout, created_at, updated_at) VALUES (1, NULL, ?, 1, 1)",
    JSON.stringify({ v: 1, preset: keys.length === 2 ? "cols-2" : "single", tracks: {}, panes: keys.map(pane), parked: parked.map(pane), maximized: null, compare: false, onlyDifferences: false, noteId: null }),
  );
const simulator = { OLLAMA_SIMULATOR: "1" };

async function axeViolations(page) {
  await page.evaluate(AXE);
  return page.evaluate(async () =>
    (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations
      .filter(v => v.impact === "serious" || v.impact === "critical")
      .map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`),
  );
}
async function axeBothThemes(page, where) {
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    // The theme's colours settle (as in desk.test.mjs).
    await page.waitForTimeout(800);
    assert.deepEqual(await axeViolations(page), [], `axe ${where}, ${colorScheme}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const chat = page => page.locator("[data-desk-chat]");
// The chips come once the panel knows the model is on (a query): wait for them, not just the panel.
const chips = async page => {
  await chat(page).locator("[data-chat-context] li").first().waitFor();
  return (await chat(page).locator("[data-chat-context] li").allTextContents()).map(s => s.trim());
};

test("desk chat: opened beside the desk with its issues as chips; a suggestion streams a markdown answer; Save as note", () =>
  withApp({ viewport: { width: 1280, height: 800 }, env: simulator, seed: seedDesk(["DEMO-101", "DEMO-102"], ["DEMO-103"]) }, async ({ page, base, db }) => {
    await page.goto(base + "/issues/desk");
    await page.locator('[data-desk-pane="1:DEMO-102"]').waitFor();
    await page.getByRole("button", { name: "Ask AI" }).click();
    const panel = page.getByRole("complementary", { name: "Ask AI about the desk" });
    await panel.waitFor();
    // The issues shown, not the parked one.
    assert.deepEqual(await chips(page), ["DEMO-101", "DEMO-102"]);
    // The desk stays beside it, in use.
    const desk = await page.locator('[data-desk-pane="1:DEMO-102"]').boundingBox();
    const side = await panel.boundingBox();
    assert.ok(desk.x + desk.width <= side.x + 1, `the desk beside the chat: ${JSON.stringify([desk, side])}`);
    await axeBothThemes(page, "with the suggestions");

    await panel.getByRole("button", { name: "Compare these issues" }).click();
    const answer = panel.locator("[data-chat-answer]").last();
    // Written as it comes: a part first, Stop offered meanwhile.
    await panel.locator('[data-chat-answer="streaming"]').filter({ hasText: "DEMO-101" }).waitFor();
    await panel.getByRole("button", { name: "Stop" }).waitFor();
    await panel.locator('[data-chat-answer="done"]').waitFor({ timeout: 20_000 });
    // Drawn as a document (a heading and lists), the whole answer said once.
    await answer.getByRole("heading", { name: "What to do first" }).waitFor();
    assert.ok((await answer.locator("li").count()) >= 4);
    assert.match(await page.locator("[data-chat-said]").textContent(), /DEMO-102/);
    await answer.getByRole("button", { name: "Copy answer" }).waitFor();
    await axeBothThemes(page, "with an answer");

    await panel.getByRole("button", { name: "Save as note" }).click();
    await page.getByText("Saved as a note, linked to DEMO-101").waitFor();
    const [note] = await db.q("SELECT title, body, issue_key FROM markdown_notes WHERE title LIKE 'Desk chat:%'");
    assert.equal(note.issue_key, "DEMO-101");
    assert.equal(note.title, "Desk chat: DEMO-101, DEMO-102");
    assert.match(note.body, /DEMO-101 \(.+\), DEMO-102 \(.+\)/);
    assert.match(note.body, /## Question\n\nCompare these issues/);

    // The desk changes: the next question reads what is shown now, and the panel says so.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("2");
    await page.keyboard.press("x");
    await page.locator('[data-desk-pane="1:DEMO-102"]').waitFor({ state: "detached" });
    await panel.getByText("The desk changed: the next question reads DEMO-101.").waitFor();
    assert.deepEqual(await chips(page), ["DEMO-101"]);
    // New chat starts over.
    await panel.getByRole("button", { name: "New chat" }).click();
    await panel.getByRole("button", { name: "Compare these issues" }).waitFor();
  }));

test("desk chat: a, Enter sends and Shift+Enter adds a line, Stop keeps what came, Esc closes", () =>
  withApp({ viewport: { width: 1280, height: 800 }, env: simulator, seed: seedDesk(["DEMO-101", "DEMO-102"]) }, async ({ page, base }) => {
    await page.goto(base + "/issues/desk");
    await page.locator('[data-desk-pane="1:DEMO-102"]').waitFor();
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("a");
    const panel = chat(page);
    const input = panel.getByRole("textbox", { name: "Your question" });
    await input.waitFor();
    await assert.doesNotReject(() => page.waitForFunction(() => document.activeElement?.matches("[data-desk-chat] textarea"), null, { timeout: 3000 }));

    await page.keyboard.type("Which one");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("first?");
    assert.equal(await input.inputValue(), "Which one\nfirst?");
    assert.equal(await panel.locator("[data-chat-answer]").count(), 0);
    await page.keyboard.press("Enter");
    assert.equal(await input.inputValue(), "");
    await panel.locator('[data-chat-answer="streaming"]').filter({ hasText: "DEMO" }).waitFor();
    await panel.getByRole("button", { name: "Stop" }).click();
    await panel.locator('[data-chat-answer="stopped"]').waitFor();
    const kept = await panel.locator('[data-chat-answer="stopped"]').textContent();
    assert.match(kept, /Stopped\./);
    await page.waitForTimeout(500);
    assert.equal(await panel.locator('[data-chat-answer="stopped"]').textContent(), kept, "nothing more after Stop");
    // Asked again: an answer to the end.
    await input.fill("And now?");
    await page.keyboard.press("Enter");
    await panel.locator('[data-chat-answer="done"]').waitFor({ timeout: 20_000 });

    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement?.textContent?.includes("Ask AI"));
    // Reopened: the conversation is still there.
    await page.getByRole("button", { name: "Ask AI" }).click();
    await chat(page).locator('[data-chat-answer="done"]').waitFor();
  }));

test("desk chat: with no local model the panel says what is needed, and never errors", () =>
  withApp({ viewport: { width: 1280, height: 800 }, seed: seedDesk(["DEMO-101", "DEMO-102"]) }, async ({ page, base }) => {
    const failures = [];
    page.on("response", res => res.status() >= 400 && res.url().includes("/api/") && failures.push(`${res.status()} ${res.url()}`));
    await page.goto(base + "/issues/desk");
    await page.locator('[data-desk-pane="1:DEMO-102"]').waitFor();
    await page.getByRole("button", { name: "Ask AI" }).click();
    await chat(page).getByText("The chat needs a local model").waitFor();
    await chat(page).getByText(/OLLAMA_URL/).waitFor();
    assert.equal(await chat(page).getByRole("textbox").count(), 0);
    await axeBothThemes(page, "with the model off");
    assert.deepEqual(failures, []);
  }));

test("desk chat on a phone: a full sheet, no sideways scroll, an answer streams", () =>
  withApp({ viewport: { width: 390, height: 844 }, env: simulator, seed: seedDesk(["DEMO-101", "DEMO-102"]) }, async ({ page, base }) => {
    await page.goto(base + "/issues/desk");
    await page.getByRole("tab", { name: "DEMO-101" }).waitFor();
    await page.getByRole("button", { name: "Ask AI" }).click();
    const sheet = page.getByRole("dialog", { name: "Ask AI about the desk" });
    await sheet.waitFor();
    await page.waitForTimeout(600);
    const box = await sheet.boundingBox();
    assert.ok(box.width >= 389, `full width: ${box.width}`);
    assert.deepEqual(await chips(page), ["DEMO-101", "DEMO-102"]);
    await axeBothThemes(page, "on a phone");
    await sheet.getByRole("button", { name: "What should I do first?" }).click();
    await sheet.locator('[data-chat-answer="done"]').waitFor({ timeout: 20_000 });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `no sideways scroll (${over}px)`);
    const past = await sheet.evaluate(el => {
      const right = el.getBoundingClientRect().right;
      return [...el.querySelectorAll("*")].filter(c => c.getBoundingClientRect().right > right + 0.5).map(c => c.tagName);
    });
    assert.deepEqual(past, [], "nothing past the sheet's edge");
    await page.getByRole("button", { name: "Close the chat" }).click();
    await sheet.waitFor({ state: "detached" });
  }));

// Batch 4d: the chat reads the user's code on their machine; the server never does.

/** The desk's issues in a project with a repository path attached (Settings → Repositories). */
const seedCode = (keys, paths = [{ label: "shop", path: "~/code/shop" }]) => async db => {
  await seedDesk(keys)(db);
  await db.q("INSERT INTO containers (connection_id, remote_id, key, name, created_at) VALUES (1, 'shop', 'SHOP', 'Shop', 1) ON CONFLICT DO NOTHING");
  const [c] = await db.q("SELECT id FROM containers WHERE remote_id = 'shop'");
  await db.q(`UPDATE issues SET container_id = ? WHERE key IN (${keys.map(() => "?").join(", ")})`, c.id, ...keys);
  for (const [i, p] of paths.entries()) await db.q("INSERT INTO container_paths (user_id, container_id, label, path, position) VALUES (1, ?, ?, ?, ?)", c.id, p.label, p.path, i);
};

/** Screenshots for review (DESK_CHAT_SHOTS=<folder>), light and dark. */
async function shots(page, name) {
  const dir = process.env.DESK_CHAT_SHOTS;
  if (!dir) return;
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.waitForTimeout(500);
    await page.locator("[data-desk-chat]").screenshot({ path: `${dir}/${name}-${colorScheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** A browser folder (File System Access) held in memory: what showDirectoryPicker gives the page. */
async function fakeFolderPicker(context) {
  await context.addInitScript(() => {
    const tree = {
      "README.md": "# Shop\r\nInventory service\r\n",
      src: { "Stock.kt": "package shop\n// DEMO-101 stock never goes below zero\nfun stock() = 0\n" },
      node_modules: { "x.js": "DEMO-101 in a dependency" },
    };
    const folder = (name, t) => ({
      kind: "directory",
      name,
      async *entries() {
        for (const [n, v] of Object.entries(t)) yield [n, typeof v === "string" ? { kind: "file", name: n } : { kind: "directory", name: n }];
      },
      async getDirectoryHandle(n) {
        if (!t[n] || typeof t[n] === "string") throw new DOMException("not found", "NotFoundError");
        return folder(n, t[n]);
      },
      async getFileHandle(n) {
        if (typeof t[n] !== "string") throw new DOMException("not found", "NotFoundError");
        return { kind: "file", name: n, getFile: async () => new File([t[n]], n) };
      },
      async queryPermission() {
        return "granted";
      },
    });
    window.__picked = 0;
    window.showDirectoryPicker = async () => {
      window.__picked++;
      return folder("shop", tree);
    };
  });
}

test("desk chat with code in a browser: Connect folder, the model greps it, the step opens to what it read", () =>
  withApp({ viewport: { width: 1280, height: 800 }, env: simulator, seed: seedCode(["DEMO-101", "DEMO-102"]) }, async ({ page, base, context }) => {
    await fakeFolderPicker(context);
    const sent = [];
    page.on("request", req => req.url().endsWith("/api/desk/chat") && sent.push(req.postDataJSON()));
    await page.goto(base + "/issues/desk");
    await page.locator('[data-desk-pane="1:DEMO-102"]').waitFor();
    await page.getByRole("button", { name: "Ask AI" }).click();
    const panel = chat(page);
    await panel.getByText("Connect a project's folder to let the model read it, read-only.").waitFor();
    await shots(page, "connect-folder");
    await axeBothThemes(page, "with Connect folder");

    await panel.getByRole("button", { name: "Connect folder" }).click();
    await panel.locator("[data-chat-repos] li", { hasText: "shop" }).waitFor();
    await panel.getByText("The model reads the code itself, read-only: files and text.").waitFor();

    await panel.getByRole("textbox", { name: "Your question" }).fill("Is DEMO-101 really solved? Look at the code");
    await page.keyboard.press("Enter");
    const step = panel.locator('[data-chat-step="done"]').first();
    await step.waitFor({ timeout: 20_000 });
    assert.equal((await step.locator("summary").textContent()).trim(), "Searching “DEMO-101” in shop: 1 hit");
    const answer = panel.locator('[data-chat-answer="done"]');
    await answer.waitFor({ timeout: 20_000 });
    // The answer cites what the step found, read here and never by the server.
    assert.match(await answer.textContent(), /src\/Stock\.kt:2: \/\/ DEMO-101 stock never goes below zero/);
    assert.equal(sent.length, 2, "one tool round, then the answer");
    assert.deepEqual(sent[0].tools, ["ls", "find", "grep", "read"]);
    assert.deepEqual(sent[0].repos, ["shop"]);
    assert.deepEqual(sent[1].messages.at(-1), { role: "tool", name: "grep", content: "src/Stock.kt:2: // DEMO-101 stock never goes below zero" });
    // Nothing of the folder went to the server but that result.
    assert.ok(!JSON.stringify(sent).includes("dependency"));

    await shots(page, "tool-steps");
    await step.locator("summary").click();
    await step.locator("[data-chat-step-text]").getByText("src/Stock.kt:2").waitFor();
    await shots(page, "step-expanded");
    await axeBothThemes(page, "with a tool step open");
  }));

test("desk chat in the app: a repository is allowed once, then the model reads it through the native commands", () =>
  withApp({ viewport: { width: 1280, height: 800 }, env: simulator, seed: seedCode(["DEMO-101"]) }, async ({ page, base, context }) => {
    await context.addInitScript(() => {
      let allowed = false;
      window.__codeCalls = [];
      window.__TAURI__ = {
        core: {
          invoke: async (cmd, args) => {
            if (cmd.startsWith("code_")) window.__codeCalls.push([cmd, args]);
            if (cmd === "native_info") return { version: "1.0.0", platform: "macos", desktop: true, autostart: false, shortcuts: [] };
            if (cmd === "code_roots") return args.roots.map(root => ({ root, allowed, git: allowed }));
            if (cmd === "code_allow_root") return (allowed = true);
            if (cmd === "code_grep") return { hits: [{ path: "src/Stock.kt", line: 2, text: "// DEMO-101 stock never goes below zero" }], truncated: false, files: 3 };
            return undefined;
          },
        },
        event: { listen: async () => () => {} },
      };
    });
    await page.goto(base + "/issues/desk");
    await page.locator('[data-desk-pane="1:DEMO-101"]').waitFor();
    await page.getByRole("button", { name: "Ask AI" }).click();
    const panel = chat(page);
    await panel.getByText("Allow a repository to let the model read it, read-only.").waitFor();
    await panel.getByRole("button", { name: "Allow shop" }).click();
    await panel.locator("[data-chat-repos] li", { hasText: "shop" }).waitFor();
    await panel.getByText("The model reads the code itself, read-only: files, text and commits.").waitFor();
    await panel.getByRole("button", { name: "What should I do first?" }).click();
    await panel.locator('[data-chat-answer="done"]').waitFor({ timeout: 20_000 });
    const calls = await page.evaluate(() => window.__codeCalls);
    assert.deepEqual(calls.find(([c]) => c === "code_allow_root"), ["code_allow_root", { root: "~/code/shop" }]);
    assert.deepEqual(calls.find(([c]) => c === "code_grep"), ["code_grep", { root: "~/code/shop", query: "DEMO-101", regex: false, glob: null }]);
    assert.match(await panel.locator('[data-chat-answer="done"]').textContent(), /src\/Stock\.kt:2/);
  }));

test("desk chat with a model that can't call tools: the page searches first and sends the extracts", () =>
  withApp({ viewport: { width: 1280, height: 800 }, env: { OLLAMA_SIMULATOR: "notools" }, seed: seedCode(["DEMO-101"]) }, async ({ page, base, context }) => {
    await fakeFolderPicker(context);
    await page.goto(base + "/issues/desk");
    await page.locator('[data-desk-pane="1:DEMO-101"]').waitFor();
    await page.getByRole("button", { name: "Ask AI" }).click();
    const panel = chat(page);
    await panel.getByRole("button", { name: "Connect folder" }).click();
    await panel.getByText(/This model can't use tools/).waitFor();
    await panel.getByRole("button", { name: "What should I do first?" }).click();
    await panel.locator('[data-chat-answer="done"]').waitFor({ timeout: 20_000 });
    assert.ok((await panel.locator("[data-chat-step]").count()) >= 1);
    assert.match(await panel.locator('[data-chat-answer="done"]').textContent(), /DEMO-101 stock never goes below zero/);
  }));

test("desk chat where code can't be reached (no folder access): it still answers, and says how to bring code in", () =>
  withApp({ viewport: { width: 1280, height: 800 }, env: simulator, seed: seedCode(["DEMO-101", "DEMO-102"]) }, async ({ page, base, context }) => {
    await context.addInitScript(() => {
      delete window.showDirectoryPicker;
    });
    await page.goto(base + "/issues/desk");
    await page.locator('[data-desk-pane="1:DEMO-102"]').waitFor();
    await page.getByRole("button", { name: "Ask AI" }).click();
    const panel = chat(page);
    await panel.getByText("Code isn't in reach here: open the desktop app, or Chrome or Edge, to bring it in.").waitFor();
    assert.equal(await panel.getByRole("button", { name: /Connect/ }).count(), 0);
    await shots(page, "no-code");
    await panel.getByRole("button", { name: "Compare these issues" }).click();
    await panel.locator('[data-chat-answer="done"]').waitFor({ timeout: 20_000 });
    assert.equal(await panel.locator("[data-chat-step]").count(), 0);
  }));
