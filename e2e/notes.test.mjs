import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "./harness.mjs";

async function withApp(options, body) {
  const app = await start(options);
  try {
    await body(app);
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
}

async function waitFor(check, message = "condition") {
  let last;
  for (let i = 0; i < 80; i++) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw last ?? new Error(`Timed out waiting for ${message}`);
}

async function createNote(page, base, db, title, body) {
  await page.goto(base + "/notes/new");
  await page.getByLabel("Note title").fill(title);
  await page.getByLabel("Markdown source").fill(body);
  await page.waitForURL(/\/notes\/[0-9a-f-]{36}\?/);
  return waitFor(async () => {
    const [row] = await db.q(
      "SELECT id, content_revision FROM markdown_notes WHERE title = ? AND body = ?",
      title,
      body
    );
    return row;
  }, "note autosave");
}

test("Markdown notes autosave, render, search from the page and palette, recover drafts and can be emptied", () =>
  withApp({}, async ({ page, base, db, context }) => {
    const created = await createNote(
      page,
      base,
      db,
      "Caffè release",
      "## Stato\n\n**Pronto** per la caffetteria."
    );
    await page.getByRole("button", { name: "Preview" }).click();
    const article = page.getByRole("article", { name: "Preview" });
    await article.getByRole("heading", { name: "Stato" }).waitFor();
    await article.getByText("Pronto", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit" }).click();

    await page.getByRole("searchbox", { name: "Search notes" }).fill("caffe");
    await page
      .getByRole("list", { name: "Note search results" })
      .getByRole("link", { name: /Caffè release/ })
      .waitFor();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox").fill("caff");
    await page.getByRole("option", { name: /Caffè release/ }).click();
    await page.waitForURL(new RegExp(`/notes/${created.id}`));
    await page.getByRole("button", { name: "Edit" }).click();

    await page.route("**/api/trpc/notes.updateContent*", route =>
      route.abort()
    );
    await page.getByLabel("Markdown source").fill("Recupero dopo reload");
    await waitFor(
      async () =>
        (await page.evaluate(
          () =>
            Object.keys(localStorage).filter(key =>
              key.startsWith("ikl-note-draft:v1:")
            ).length
        )) > 0,
      "local draft"
    );
    await page.unroute("**/api/trpc/notes.updateContent*");
    await page.reload();
    await page.getByRole("button", { name: "Recover draft" }).click();
    await waitFor(
      async () =>
        (
          await db.q("SELECT body FROM markdown_notes WHERE id = ?", created.id)
        )[0]?.body === "Recupero dopo reload",
      "recovered save"
    );
    const editAfterRecovery = page.getByRole("button", { name: "Edit", exact: true });
    if (await editAfterRecovery.count()) await editAfterRecovery.click();

    await context.setOffline(true);
    await page.getByLabel("Markdown source").fill("Bozza offline");
    await page.getByText("Offline · draft kept").waitFor();
    await context.setOffline(false);
    await waitFor(
      async () =>
        (
          await db.q("SELECT body FROM markdown_notes WHERE id = ?", created.id)
        )[0]?.body === "Bozza offline",
      "online retry"
    );

    await page.getByLabel("Note title").fill("");
    await page.getByLabel("Markdown source").fill("");
    await waitFor(async () => {
      const [row] = await db.q(
        "SELECT title, body, content_revision FROM markdown_notes WHERE id = ?",
        created.id
      );
      return (
        row?.title === "" &&
        row?.body === "" &&
        row.content_revision > created.content_revision
      );
    }, "empty document save");
  }));

test("the editor fills its area, has an explicit Save action and keeps a safe source fallback in preview", () =>
  withApp({}, async ({ page, base, db }) => {
    const created = await createNote(page, base, db, "Safe preview", "Initial");
    const editorHeight = await page
      .locator("#note-body")
      .evaluate(element => element.getBoundingClientRect().height);
    assert.ok(editorHeight > 400, `editor height: ${editorHeight}`);

    await page.getByLabel("Markdown source").fill("Saved explicitly");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await waitFor(
      async () =>
        (
          await db.q("SELECT body FROM markdown_notes WHERE id = ?", created.id)
        )[0]?.body === "Saved explicitly",
      "explicit save"
    );

    await page
      .getByRole("article", { name: "Preview" })
      .getByText("Saved explicitly", { exact: true })
      .waitFor();
    assert.match(page.url(), /view=preview/);
    await page.reload();
    await page
      .getByRole("article", { name: "Preview" })
      .getByText("Saved explicitly", { exact: true })
      .waitFor();
    assert.equal(
      (await db.q("SELECT count(*)::int AS n FROM markdown_note_versions"))[0]
        .n,
      0
    );
    await page.getByRole("button", { name: "Edit" }).click();
    const source = "<script>alert('not rendered')</script>";
    await page.getByLabel("Markdown source").fill(source);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await waitFor(
      async () =>
        (
          await db.q("SELECT body FROM markdown_notes WHERE id = ?", created.id)
        )[0]?.body === source,
      "fallback source save"
    );
    await page
      .getByText("The preview is unavailable. Return to the Markdown source.")
      .waitFor();
    await page
      .locator("article pre")
      .getByText(source, { exact: true })
      .waitFor();
  }));

test("two tabs preserve conflicting versions and save the local one as a copy", () =>
  withApp({}, async ({ page, base, db, context }) => {
    await page.route("**/api/events", route => route.abort());
    const created = await createNote(page, base, db, "Shared note", "Initial");
    const other = await context.newPage();
    await other.route("**/api/events", route => route.abort());
    await other.goto(`${base}/notes/${created.id}`);
    await other
      .getByRole("article", { name: "Preview" })
      .getByText("Initial", { exact: true })
      .waitFor();
    await other.getByRole("button", { name: "Edit" }).click();
    await other.getByLabel("Markdown source").waitFor();
    await other.getByLabel("Markdown source").fill("Server version");
    await waitFor(
      async () =>
        (
          await db.q("SELECT body FROM markdown_notes WHERE id = ?", created.id)
        )[0]?.body === "Server version",
      "second tab save"
    );

    await page.getByLabel("Markdown source").fill("My local version");
    await page.getByText("This note changed elsewhere").waitFor();
    await page.getByRole("button", { name: "Compare versions" }).click();
    const comparison = await page.locator("pre").allTextContents();
    assert.ok(comparison.some(text => text.includes("My local version")));
    assert.ok(comparison.some(text => text.includes("Server version")));
    await page.getByRole("button", { name: "Save mine as a copy" }).click();
    await page.waitForURL(
      url =>
        /\/notes\/[0-9a-f-]{36}$/.test(url.pathname) &&
        !url.pathname.includes(created.id)
    );
    await waitFor(
      async () =>
        (
          await db.q(
            "SELECT count(*)::int AS n FROM markdown_notes WHERE body = 'My local version'"
          )
        )[0].n === 1,
      "conflict copy"
    );
    assert.equal(
      (
        await db.q("SELECT body FROM markdown_notes WHERE id = ?", created.id)
      )[0].body,
      "Server version"
    );
    await other.close();
  }));

test("hierarchy, issue links, history, move and trash restore stay consistent", () =>
  withApp({}, async ({ page, base, db }) => {
    const parent = await createNote(
      page,
      base,
      db,
      "Project notebook",
      "Version one"
    );
    await page.getByRole("button", { name: "History" }).click();
    await page.getByRole("button", { name: "Save version" }).click();
    await page.getByText("Version saved").waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByLabel("Markdown source").fill("Version two");
    await waitFor(
      async () =>
        (
          await db.q("SELECT body FROM markdown_notes WHERE id = ?", parent.id)
        )[0]?.body === "Version two",
      "second version"
    );
    await page.getByRole("button", { name: "History" }).click();
    await page.getByRole("button", { name: "Save version" }).click();
    await page.getByText("Version saved").waitFor();
    await page.getByRole("button", { name: "Close", exact: true }).click();

    await page.getByRole("button", { name: "Link issue", exact: true }).click();
    const linkDialog = page.getByRole("dialog", { name: "Link an issue" });
    await linkDialog.getByRole("combobox").click();
    await page.getByRole("option", { name: /DEMO-101/ }).click();
    await linkDialog
      .getByRole("button", { name: "Link issue", exact: true })
      .click();
    await waitFor(
      async () =>
        (
          await db.q(
            "SELECT issue_key FROM markdown_notes WHERE id = ?",
            parent.id
          )
        )[0]?.issue_key === "DEMO-101",
      "issue link"
    );

    await page.getByRole("link", { name: "New child note" }).click();
    await page.waitForURL(/\/notes\/new\?/);
    await page.waitForFunction(
      () => document.querySelector("#note-title")?.value === ""
    );
    await page.getByLabel("Note title").fill("Child decision");
    await page.getByLabel("Markdown source").fill("Nested body");
    await page.waitForURL(/\/notes\/[0-9a-f-]{36}\?/);
    const child = await waitFor(
      async () =>
        (
          await db.q(
            "SELECT id, parent_id FROM markdown_notes WHERE title = 'Child decision'"
          )
        )[0],
      "child note"
    );
    assert.equal(child.parent_id, parent.id);

    await page.goto(base + "/issues/DEMO-101");
    await page
      .getByRole("link", { name: "Project notebook", exact: true })
      .waitFor();
    await page.goto(`${base}/notes/${parent.id}`);
    await page.getByRole("button", { name: "History" }).click();
    const manual = page
      .getByRole("listitem")
      .filter({ hasText: "Version one" })
      .first();
    await manual.getByRole("button", { name: "Restore" }).click();
    await waitFor(
      async () =>
        (
          await db.q("SELECT body FROM markdown_notes WHERE id = ?", parent.id)
        )[0]?.body === "Version one",
      "version restore"
    );

    await page.getByRole("button", { name: "History" }).click();
    await page.getByRole("button", { name: "Compact", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Compact", exact: true })
      .click();
    await waitFor(
      async () =>
        (await db.q("SELECT count(*)::int AS n FROM markdown_note_versions"))[0]
          .n === 1,
      "history compact"
    );
    assert.equal(
      (await db.q("SELECT body FROM markdown_notes WHERE id = ?", parent.id))[0]
        .body,
      "Version one"
    );

    const deletedVersion = page
      .getByRole("listitem")
      .filter({ hasText: "manual" })
      .first();
    await deletedVersion
      .getByRole("button", { name: "Delete version", exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete version", exact: true })
      .click();
    await waitFor(
      async () =>
        (
          await db.q(
            "SELECT count(*)::int AS n FROM markdown_note_versions WHERE origin = 'manual'"
          )
        )[0].n === 0,
      "version delete"
    );
    assert.equal(
      (await db.q("SELECT body FROM markdown_notes WHERE id = ?", parent.id))[0]
        .body,
      "Version one"
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();

    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByText("This also moves 1 descendant notes.")
      .waitFor();
    await page.getByRole("button", { name: "Move to Trash" }).click();
    await waitFor(
      async () =>
        (
          await db.q(
            "SELECT count(*)::int AS n FROM markdown_notes WHERE deleted_at IS NOT NULL"
          )
        )[0].n === 2,
      "branch delete"
    );
    await page.getByRole("link", { name: "Trash" }).click();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await waitFor(
      async () =>
        (
          await db.q(
            "SELECT count(*)::int AS n FROM markdown_notes WHERE deleted_at IS NULL"
          )
        )[0].n === 2,
      "branch restore"
    );

    await page.goto(`${base}/notes/${child.id}`);
    await page.getByRole("button", { name: "Move", exact: true }).click();
    const moveDialog = page.getByRole("dialog", { name: "Move note" });
    await moveDialog.getByRole("combobox").click();
    await page.getByRole("option", { name: "Top level" }).click();
    await moveDialog
      .getByRole("button", { name: "Move note", exact: true })
      .click();
    await waitFor(
      async () =>
        (
          await db.q(
            "SELECT parent_id FROM markdown_notes WHERE id = ?",
            child.id
          )
        )[0]?.parent_id === null,
      "move to root"
    );
  }));

test("notes work on a phone without horizontal overflow", () =>
  withApp(
    {
      viewport: { width: 390, height: 844 },
      seed: async db => {
        const now = Date.now();
        await db.q(
          "INSERT INTO markdown_notes (user_id, title, body, body_text, search_title, search_text, created_at, updated_at) VALUES (1, 'Mobile note', 'Body', 'Body', 'mobile note', 'body', ?, ?)",
          now,
          now
        );
      },
    },
    async ({ page, base }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(base + "/notes");
      const description = page.getByText(
        "Private Markdown documents, on their own or linked to an issue.",
        { exact: true }
      );
      const descriptionY = await description.evaluate(
        element => element.getBoundingClientRect().y
      );
      await page
        .getByRole("link", { name: "Mobile note", exact: true })
        .click();
      // Measured once the note is there (mid-render the page is still settling).
      await page
        .getByRole("article", { name: "Preview" })
        .getByText("Body", { exact: true })
        .waitFor();
      assert.equal(
        await description.evaluate(
          element => element.getBoundingClientRect().y
        ),
        descriptionY
      );
      await page.getByRole("button", { name: "Edit" }).click();
      await page.getByLabel("Markdown source").waitFor();
      assert.equal(
        await page.getByRole("navigation", { name: "Notes hierarchy" }).count(),
        0
      );
      await page.getByRole("link", { name: "Notes", exact: true }).click();
      await page.getByRole("navigation", { name: "Notes hierarchy" }).waitFor();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth
      );
      assert.ok(overflow <= 1, `horizontal overflow: ${overflow}`);
    }
  ));
