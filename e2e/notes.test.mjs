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

    // A sub-note from the note's own menu in the tree.
    await page.getByRole("button", { name: "Actions for Project notebook" }).click();
    await page.getByRole("menuitem", { name: "New note here" }).click();
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
        .getByRole("treeitem", { name: "Mobile note", exact: true })
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

test("folders like a file manager: make, rename, fill, open, move, keyboard, delete", () =>
  withApp({}, async ({ page, base, db }) => {
    const row = async title => (await db.q("SELECT id, kind, parent_id, deleted_at FROM markdown_notes WHERE title = ?", title))[0];
    await page.goto(base + "/notes");
    const tree = page.getByRole("tree", { name: "Notes hierarchy" });

    // The header's New folder makes one at once, its name open for typing.
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    const name = page.getByRole("textbox", { name: "Name of New folder" });
    await name.waitFor();
    await name.fill("Work");
    await name.press("Enter");
    await tree.getByRole("treeitem", { name: "Work, Folder" }).waitFor();
    const work = await waitFor(() => row("Work"), "folder saved");
    assert.equal(work.kind, "folder");

    // A right-click on it: a note inside.
    await tree.getByRole("treeitem", { name: "Work, Folder" }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "New note here" }).click();
    await page.waitForURL(/\/notes\/new\?/);
    await page.getByLabel("Note title").fill("Plan");
    await page.getByLabel("Markdown source").fill("Steps");
    await page.waitForURL(/\/notes\/[0-9a-f-]{36}\?/);
    assert.equal((await waitFor(() => row("Plan"), "note saved")).parent_id, work.id);

    // The open note's breadcrumb goes through its folder, a step that opens it.
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Work" }).waitFor();

    // Enter opens the folder's view: where it is and what it holds (a click toggles the branch).
    await tree.getByRole("treeitem", { name: "Work, Folder" }).focus();
    await page.keyboard.press("Enter");
    const contents = page.getByRole("region", { name: "Contents of Work" });
    await contents.getByRole("link", { name: /Plan/ }).waitFor();
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Work").waitFor();
    // A folder made from the view is named there too.
    await contents.getByRole("button", { name: "New folder here" }).click();
    const inner = contents.getByRole("textbox", { name: "Name of New folder" });
    await inner.fill("Meetings");
    await inner.press("Enter");
    await contents.getByRole("link", { name: /Meetings/ }).waitFor();
    assert.equal((await waitFor(() => row("Meetings"), "inner folder")).parent_id, work.id);
    // Folders first, then notes.
    assert.deepEqual(
      (await contents.getByRole("list").getByRole("link").allInnerTexts()).map(text => text.split("\n")[0]),
      ["Meetings", "Plan"]
    );

    // F2 renames inline; Esc leaves it as it was.
    await tree.getByRole("treeitem", { name: "Plan" }).focus();
    await page.keyboard.press("F2");
    const plan = page.getByRole("textbox", { name: "Name of Plan" });
    await plan.fill("Plan 2027");
    await plan.press("Enter");
    await waitFor(() => row("Plan 2027"), "renamed");
    await tree.getByRole("treeitem", { name: "Plan 2027" }).focus();
    await page.keyboard.press("F2");
    await page.getByRole("textbox", { name: "Name of Plan 2027" }).press("Escape");
    await tree.getByRole("treeitem", { name: "Plan 2027" }).waitFor();

    // Arrows: up to the parent with Left, Home to the first row, type-ahead.
    await tree.getByRole("treeitem", { name: "Plan 2027" }).focus();
    await page.keyboard.press("ArrowLeft");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Work, Folder");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await tree.getByRole("treeitem", { name: "Work, Folder" }).getAttribute("aria-expanded"), "false");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Meetings, Folder");
    await page.keyboard.press("Home");
    await page.keyboard.type("p");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Plan 2027");

    // Search finds a folder by name; it opens its view.
    await page.getByRole("searchbox", { name: "Search notes" }).fill("meet");
    await page.getByRole("list", { name: "Note search results" }).getByRole("link", { name: "Meetings, Folder" }).click();
    await page.getByRole("region", { name: "Contents of Meetings" }).waitFor();
    await page.getByRole("searchbox", { name: "Search notes" }).fill("");

    // Move to…: a folder goes only to the top level or into folders.
    await page.getByRole("button", { name: "Actions for Meetings" }).click();
    await page.getByRole("menuitem", { name: "Move to…" }).click();
    const move = page.getByRole("dialog", { name: "Move folder" });
    await move.getByRole("combobox").click();
    assert.equal(await page.getByRole("option", { name: "Plan 2027" }).count(), 0, "a note is never offered to a folder");
    await page.getByRole("option", { name: "Top level" }).click();
    await move.getByRole("button", { name: "Move folder" }).click();
    await waitFor(async () => (await row("Meetings")).parent_id === null, "moved to the top level");

    // Delete on a row asks, saying what goes with it; the branch goes to the trash.
    await tree.getByRole("treeitem", { name: "Work, Folder" }).focus();
    await page.keyboard.press("Delete");
    const ask = page.getByRole("alertdialog", { name: "Move folder to Trash?" });
    await ask.getByText(/also moves the 1 notes and folders inside/).waitFor();
    await ask.getByRole("button", { name: "Move to Trash" }).click();
    await waitFor(async () => (await row("Plan 2027")).deleted_at !== null, "branch in the trash");
    assert.equal(await tree.getByRole("treeitem", { name: "Work, Folder" }).count(), 0);
  }));

test("a note that only groups others becomes a folder; one with text is never offered it", () =>
  withApp(
    {
      viewport: { width: 320, height: 760 },
      seed: async db => {
        const now = Date.now();
        const add = async (id, parent, title, body) =>
          db.q(
            "INSERT INTO markdown_notes (id, user_id, parent_id, title, body, body_text, search_title, search_text, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
            id, parent, title, body, body, title.toLowerCase(), body.toLowerCase(), now, now
          );
        await add("00000000-0000-4000-8000-000000000001", null, "Area", "");
        await add("00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001", "Inside", "x");
        await add("00000000-0000-4000-8000-000000000003", null, "Written", "words");
        await add("00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000003", "Under", "y");
      },
    },
    async ({ page, base, db }) => {
      await page.goto(base + "/notes");
      const tree = page.getByRole("tree", { name: "Notes hierarchy" });
      await tree.getByRole("treeitem", { name: "Written" }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Move to…" }).waitFor();
      assert.equal(await page.getByRole("menuitem", { name: "Convert to folder" }).count(), 0);
      await page.keyboard.press("Escape");
      await tree.getByRole("treeitem", { name: "Area" }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Convert to folder" }).click();
      await page.getByText("Now a folder").waitFor();
      await tree.getByRole("treeitem", { name: "Area, Folder" }).waitFor();
      assert.equal((await db.q("SELECT kind FROM markdown_notes WHERE title = 'Area'"))[0].kind, "folder");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `horizontal overflow: ${overflow}`);
    }
  ));

test("moving: drag into a folder or beside a row, never a folder into a note, Move to… by search, each with Undo", () =>
  withApp(
    {
      seed: async db => {
        const now = Date.now();
        const add = (id, parent, kind, title, position) =>
          db.q(
            "INSERT INTO markdown_notes (id, user_id, parent_id, kind, title, body, position, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)",
            id, parent, kind, title, kind === "note" ? "text" : "", position, now, now
          );
        await add("00000000-0000-4000-8000-0000000000b1", null, "folder", "Alpha", 0);
        await add("00000000-0000-4000-8000-0000000000b2", null, "folder", "Beta", 1);
        await add("00000000-0000-4000-8000-0000000000b3", null, "note", "Loose", 2);
        await add("00000000-0000-4000-8000-0000000000b4", "00000000-0000-4000-8000-0000000000b1", "note", "Inner", 0);
      },
    },
    async ({ page, base, db }) => {
      const parentOf = async title => (await db.q("SELECT parent_id FROM markdown_notes WHERE title = ?", title))[0].parent_id;
      const rootOrder = async () => (await db.q("SELECT title FROM markdown_notes WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY position")).map(r => r.title);
      await page.goto(base + "/notes");
      const tree = page.getByRole("tree", { name: "Notes hierarchy" });
      const item = name => tree.getByRole("treeitem", { name, exact: true });
      const middle = async locator => {
        const box = await locator.boundingBox();
        return { x: box.width / 2, y: box.height / 2 };
      };

      // Into a folder: dropped on its middle; Undo puts it back.
      await item("Loose").dragTo(item("Beta, Folder"), { targetPosition: await middle(item("Beta, Folder")) });
      await waitFor(async () => (await parentOf("Loose")) === "00000000-0000-4000-8000-0000000000b2", "dropped into Beta");
      await page.getByRole("button", { name: "Undo" }).click();
      await waitFor(async () => (await parentOf("Loose")) === null, "undone");

      // Beside a row: on its top edge, before it.
      const alpha = item("Alpha, Folder");
      await item("Beta, Folder").dragTo(alpha, { targetPosition: { x: 40, y: 2 } });
      await waitFor(async () => (await rootOrder()).join() === "Beta,Alpha,Loose", "Beta before Alpha");

      // A folder never goes inside a note: nothing happens.
      await item("Alpha, Folder").dragTo(item("Loose"), { targetPosition: await middle(item("Loose")) });
      await page.waitForTimeout(300);
      assert.equal(await parentOf("Alpha"), null);

      // Move to…, by search, with its path.
      await item("Loose").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Move to…" }).click();
      const dialog = page.getByRole("dialog", { name: "Move note" });
      await dialog.getByRole("combobox").fill("alp");
      await dialog.getByRole("option", { name: "Alpha", exact: true }).click();
      assert.equal(await dialog.getByRole("option", { name: "Beta", exact: true }).count(), 0, "search narrows the places");
      await dialog.getByRole("button", { name: "Move note" }).click();
      await waitFor(async () => (await parentOf("Loose")) === "00000000-0000-4000-8000-0000000000b1", "moved into Alpha");
      // The newest toast's Undo (an earlier move's may still show below it).
      await page.getByRole("button", { name: "Undo" }).first().click();
      await waitFor(async () => (await parentOf("Loose")) === null, "undone again");
    }
  ));

test("a long title inside nested folders truncates: the tree never scrolls sideways and only the open row stands out", async () => {
  const long = "Proposta AI per call center con riassunti automatici delle chiamate, instradamento e report settimanali per il cliente";
  const seed = async db => {
    const now = Date.now();
    const add = (id, parent, kind, title) =>
      db.q(
        "INSERT INTO markdown_notes (id, user_id, parent_id, kind, title, body, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
        id, parent, kind, title, kind === "note" ? "text" : "", now, now
      );
    await add("00000000-0000-4000-8000-0000000000c1", null, "folder", "Clients");
    await add("00000000-0000-4000-8000-0000000000c2", "00000000-0000-4000-8000-0000000000c1", "folder", "Call center");
    await add("00000000-0000-4000-8000-0000000000c3", "00000000-0000-4000-8000-0000000000c2", "note", long);
    await add("00000000-0000-4000-8000-0000000000c4", null, "note", "Short");
  };
  for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 760 }]) {
    await withApp({ viewport, seed }, async ({ page, base }) => {
      // On a phone an open note hides the tree: look at the tree with nothing open there.
      const path = viewport.width >= 1024 ? "/notes/00000000-0000-4000-8000-0000000000c3" : "/notes";
      await page.goto(base + path);
      const tree = page.getByRole("tree", { name: "Notes hierarchy" });
      // Arrows open the branches (a click opens a folder's view, which on a phone hides the tree).
      await tree.getByRole("treeitem", { name: "Clients, Folder" }).focus();
      await page.keyboard.press("ArrowRight");
      await tree.getByRole("treeitem", { name: "Call center, Folder" }).focus();
      await page.keyboard.press("ArrowRight");
      const row = tree.getByRole("treeitem", { name: long });
      await row.waitFor();
      const sizes = await page.evaluate(() => {
        const aside = document.querySelector('[data-scroll-key="notes-tree"]');
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          aside: aside ? aside.scrollWidth - aside.clientWidth : -1,
        };
      });
      assert.ok(sizes.page <= 1, `page scrolls sideways at ${viewport.width}px: ${sizes.page}`);
      assert.ok(sizes.aside <= 1, `tree scrolls sideways at ${viewport.width}px: ${sizes.aside}`);
      const label = row.locator("span.truncate").first();
      assert.ok(await label.evaluate(el => el.scrollWidth > el.clientWidth), "the long title is cut with an ellipsis");
      // Every row may stand out, the Shadow mod lifts it only off the ones that aren't the open one.
      const short = tree.getByRole("treeitem", { name: "Short" });
      assert.equal(await short.getAttribute("data-surface-current"), "", "a closed row is marked current-only");
    });
  }
});

test("a click on a folder's row opens and closes it, not only its arrow; on a phone the tree stays", async () => {
  const seed = async db => {
    const now = Date.now();
    const add = (id, parent, kind, title) =>
      db.q(
        "INSERT INTO markdown_notes (id, user_id, parent_id, kind, title, body, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
        id, parent, kind, title, kind === "note" ? "text" : "", now, now
      );
    await add("00000000-0000-4000-8000-0000000000d1", null, "folder", "Jakala");
    await add("00000000-0000-4000-8000-0000000000d2", "00000000-0000-4000-8000-0000000000d1", "note", "Kickoff");
  };
  for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 760 }]) {
    await withApp({ viewport, seed }, async ({ page, base }) => {
      await page.goto(base + "/notes");
      const tree = page.getByRole("tree", { name: "Notes hierarchy" });
      const folder = tree.getByRole("treeitem", { name: "Jakala, Folder" });
      const child = tree.getByRole("treeitem", { name: "Kickoff" });
      await folder.click();
      await child.waitFor();
      assert.equal(await folder.getAttribute("aria-expanded"), "true");
      if (viewport.width >= 1024) await page.getByRole("region", { name: "Contents of Jakala" }).waitFor();
      await folder.click();
      await child.waitFor({ state: "detached" });
      assert.equal(await folder.getAttribute("aria-expanded"), "false");
      // The tree is still there to keep going (a phone never swaps it for the folder's view on a click).
      assert.ok(await tree.isVisible());
    });
  }
});

test("a click on a folder acts on that folder only: a parent of the open note closes, the open folder stays closed", async () => {
  const seed = async db => {
    const now = Date.now();
    const add = (id, parent, kind, title) =>
      db.q(
        "INSERT INTO markdown_notes (id, user_id, parent_id, kind, title, body, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)",
        id, parent, kind, title, kind === "note" ? "text" : "", now, now
      );
    await add("00000000-0000-4000-8000-0000000000e1", null, "folder", "Jakala");
    await add("00000000-0000-4000-8000-0000000000e2", "00000000-0000-4000-8000-0000000000e1", "folder", "MrCall");
    await add("00000000-0000-4000-8000-0000000000e3", "00000000-0000-4000-8000-0000000000e2", "note", "Proposta");
    await add("00000000-0000-4000-8000-0000000000e4", null, "folder", "Codemotion");
    await add("00000000-0000-4000-8000-0000000000e5", "00000000-0000-4000-8000-0000000000e4", "note", "Talk");
  };
  await withApp({ viewport: { width: 1280, height: 800 }, seed }, async ({ page, base }) => {
    await page.goto(base + "/notes/00000000-0000-4000-8000-0000000000e3");
    const tree = page.getByRole("tree", { name: "Notes hierarchy" });
    const jakala = tree.getByRole("treeitem", { name: "Jakala, Folder" });
    const mrcall = tree.getByRole("treeitem", { name: "MrCall, Folder" });
    // The open note's branch shows; its outer folder closes on a click all the same.
    await tree.getByRole("treeitem", { name: "Proposta" }).waitFor();
    await jakala.click();
    await mrcall.waitFor({ state: "detached" });
    assert.equal(await jakala.getAttribute("aria-expanded"), "false");
    // Another folder opening leaves the closed one closed.
    await tree.getByRole("treeitem", { name: "Codemotion, Folder" }).click();
    await tree.getByRole("treeitem", { name: "Talk" }).waitFor();
    assert.equal(await jakala.getAttribute("aria-expanded"), "false");
    // The open folder closed by hand stays closed when another one is clicked.
    await tree.getByRole("treeitem", { name: "Codemotion, Folder" }).click();
    await tree.getByRole("treeitem", { name: "Talk" }).waitFor({ state: "detached" });
    await jakala.click();
    await mrcall.waitFor();
    assert.equal(await tree.getByRole("treeitem", { name: "Codemotion, Folder" }).getAttribute("aria-expanded"), "false");
  });
});
