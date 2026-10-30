// Notes by date: a note has its own day, the search reads `date:` / `data:` (and
// the chips), the diary shows each day, and the AI tidies a note into a copy
// kept beside it (Original | AI) until it is kept or discarded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { awayFromMidnight, withApp } from "./harness.mjs";

const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const yesterday = () => day(new Date(Date.now() - 86_400_000));

async function waitFor(check, message) {
  for (let i = 0; i < 80; i++) {
    const v = await check().catch(() => null);
    if (v) return v;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out: ${message}`);
}

const seed = async db => {
  const now = Date.now();
  const add = (id, title, body, notedOn) =>
    db.q(
      "INSERT INTO markdown_notes (id, user_id, kind, title, body, body_text, search_title, search_text, noted_on, created_at, updated_at) VALUES (?, 1, 'note', ?, ?, ?, ?, ?, ?, ?, ?)",
      id, title, body, body, title.toLowerCase(), body.toLowerCase(), notedOn, now, now
    );
  await add("00000000-0000-4000-8000-0000000000f1", "Call MrCall", "Pilot in November", yesterday());
  await add("00000000-0000-4000-8000-0000000000f2", "Standup", "Import done", day());
  await add("00000000-0000-4000-8000-0000000000f3", "Old plan", "Long ago", "2025-01-10");
};

test("notes found by date alone: a chip or data:ieri, without typing words", { timeout: 600_000 }, async () => {
  await awayFromMidnight(2 * 60_000, 2 * 60_000);
  await withApp({ seed }, async ({ page, base }) => {
    await page.goto(base + "/notes");
    const results = page.getByRole("list", { name: "Note search results" });
    await page.getByRole("group", { name: "Notes by date" }).getByRole("button", { name: "Today" }).click();
    await results.getByRole("link", { name: /Standup/ }).waitFor();
    assert.equal(await results.getByRole("link", { name: /Call MrCall/ }).count(), 0);
    await page.getByRole("searchbox", { name: "Search notes" }).fill("data:ieri");
    await results.getByRole("link", { name: /Call MrCall/ }).waitFor();
    await page.getByRole("searchbox", { name: "Search notes" }).fill("date:2025-01-01..2025-01-31 long");
    await results.getByRole("link", { name: /Old plan/ }).waitFor();
    await page.getByRole("searchbox", { name: "Search notes" }).fill("data:presto");
    await page.getByText(/^Not a date: data:presto/).waitFor();
  });
});

test("the diary: each day's notes, a note made for a day carries it", { timeout: 600_000 }, async () => {
  await awayFromMidnight(2 * 60_000, 2 * 60_000);
  await withApp({ seed }, async ({ page, base, db }) => {
    await page.goto(base + "/notes");
    await page.getByRole("link", { name: "Diary" }).click();
    const days = page.getByRole("list", { name: "Days of the period" });
    await days.getByRole("link", { name: "Standup" }).waitFor();
    // Yesterday may be last week on a Monday: the week before has it then.
    if ((await days.getByRole("link", { name: "Call MrCall" }).count()) === 0) await page.getByRole("button", { name: "Previous period" }).click();
    await days.getByRole("link", { name: "Call MrCall" }).waitFor();
    await page.getByRole("link", { name: /^New note for / }).first().click();
    await page.getByLabel("Note title").fill("Written for a day");
    await page.getByLabel("Markdown source").fill("from the diary");
    const [row] = await waitFor(async () => {
      const rows = await db.q("SELECT noted_on FROM markdown_notes WHERE title = 'Written for a day'");
      return rows.length ? rows : null;
    }, "note saved");
    assert.match(row.noted_on, /^\d{4}-\d{2}-\d{2}$/);
  });
});

test("the diary at 320 px never scrolls sideways", { timeout: 600_000 }, async () => {
  await withApp({ seed, viewport: { width: 320, height: 760 } }, async ({ page, base }) => {
    await page.goto(base + "/notes/diary");
    await page.getByRole("list", { name: "Days of the period" }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `horizontal overflow: ${overflow}`);
  });
});

test("tidy up with AI: the copy goes beside the note; Keep AI swaps it, Undo brings the original back", { timeout: 600_000 }, async () => {
  await withApp({ seed, env: { OLLAMA_SIMULATOR: "1" } }, async ({ page, base, db }) => {
    await page.goto(base + "/notes/00000000-0000-4000-8000-0000000000f2?view=edit");
    await page.getByRole("button", { name: "Tidy up with AI" }).click();
    const versions = page.getByRole("radiogroup", { name: "Version shown" });
    await versions.waitFor();
    const copy = page.getByRole("article", { name: "AI" });
    await copy.getByRole("heading", { name: "Standup" }).waitFor();
    // The note itself is unchanged until the copy is kept.
    assert.equal((await db.q("SELECT body FROM markdown_notes WHERE title = 'Standup'"))[0].body, "Import done");
    await versions.getByRole("radio", { name: "Original" }).click();
    assert.equal(await page.getByLabel("Markdown source").inputValue(), "Import done");
    await versions.getByRole("radio", { name: /AI/ }).click();
    await copy.getByRole("button", { name: "Keep AI" }).click();
    await waitFor(async () => (await db.q("SELECT body FROM markdown_notes WHERE title = 'Standup'"))[0].body.startsWith("## Standup"), "kept");
    await page.locator("[data-sonner-toast]").getByRole("button", { name: "Undo" }).click();
    await waitFor(async () => (await db.q("SELECT body FROM markdown_notes WHERE title = 'Standup'"))[0].body === "Import done", "undone");
    assert.equal((await db.q("SELECT origin FROM markdown_note_versions WHERE origin = 'ai'")).length, 1);
  });
});
