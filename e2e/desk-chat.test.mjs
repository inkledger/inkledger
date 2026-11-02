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
const chips = async page => (await chat(page).locator("[data-chat-context] li").allTextContents()).map(s => s.trim());

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
