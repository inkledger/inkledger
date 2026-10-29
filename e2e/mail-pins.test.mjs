// Pinned mails: a pasted Outlook link, a dropped .eml file, the pinboard and a TODO about a mail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { start, withApp } from "./harness.mjs";

const ID = "AAQkADAwATM0MDAAMS1iNTcwLWI2NTEtMDACLTAwCgAQAGxqR1k8Q3FAqK-hm_o3Zr8=";
const EML = [
  "From: =?UTF-8?Q?Gi=C3=B9lia_Rossi?= <giulia@example.com>",
  "Subject: Budget 2027",
  "Date: Tue, 27 Oct 2026 10:00:00 +0100",
  "Message-ID: <budget-2027@example.com>",
  "",
  "The body is never read.",
].join("\r\n");

test("a pasted link and a dropped .eml pin to an issue; one goes on the board, one a TODO is about", () =>
  withApp({}, async ({ page, base, db }) => {
    await page.goto(base + "/issues/DEMO-101");
    const pinButton = page.getByRole("button", { name: "Pin a mail" });
    await pinButton.waitFor();

    // A pasted Outlook link: the subject is typed, the link kept in its stable form.
    await pinButton.click();
    const dialog = page.getByRole("dialog", { name: "Pin a mail" });
    await dialog.getByRole("textbox", { name: "Outlook link" }).fill(`https://outlook.office.com/mail/inbox/id/${encodeURIComponent(ID)}`);
    await dialog.getByRole("textbox", { name: "Subject", exact: true }).fill("Release 2.3");
    await dialog.getByRole("button", { name: "Pin", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByText("Release 2.3", { exact: true }).waitFor();
    const [linked] = await db.q("SELECT subject, web_link, source FROM mails");
    assert.deepEqual(linked, { subject: "Release 2.3", web_link: `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(ID)}`, source: "link" });

    // A dropped .eml: everything read from its headers, pinned at once.
    const section = pinButton.locator("xpath=../..");
    const data = await page.evaluateHandle(text => {
      const d = new DataTransfer();
      d.items.add(new File([text], "budget.eml", { type: "message/rfc822" }));
      return d;
    }, EML);
    await section.dispatchEvent("dragover", { dataTransfer: data });
    await section.dispatchEvent("drop", { dataTransfer: data });
    await page.getByText("Budget 2027", { exact: true }).waitFor();
    await page.getByText(/^Giùlia Rossi · /).waitFor();
    assert.deepEqual(
      await db.q("SELECT m.subject, m.from_address, m.internet_message_id, l.issue_key FROM mails m JOIN mail_links l ON l.mail_id = m.id ORDER BY m.id"),
      [
        { subject: "Release 2.3", from_address: null, internet_message_id: null, issue_key: "DEMO-101" },
        { subject: "Budget 2027", from_address: "giulia@example.com", internet_message_id: "budget-2027@example.com", issue_key: "DEMO-101" },
      ],
    );

    // On the pinboard.
    await page.getByRole("button", { name: "Put Budget 2027 on the pinboard" }).click();
    await page.getByText(/^On the board /).waitFor();
    assert.equal((await db.q("SELECT count(*)::int AS n FROM pinboard_notes WHERE mail_id IS NOT NULL"))[0].n, 1);

    // A TODO about the mail: its chip shows the subject.
    const capture = page.getByRole("textbox", { name: "New TODO" }).first();
    await capture.fill("Answer Giulia");
    await page.keyboard.press("Enter");
    const row = page.getByRole("listitem", { name: "Answer Giulia" });
    await row.waitFor();
    await row.getByRole("button", { name: "Actions for “Answer Giulia”" }).click();
    await page.getByRole("menuitem", { name: "About a mail…" }).click();
    const picker = page.getByRole("dialog", { name: "Pin a mail" });
    await picker.getByRole("button", { name: /Budget 2027/ }).click();
    await picker.waitFor({ state: "detached" });
    await row.getByTitle("About the mail Budget 2027").waitFor();
    const [todo] = await db.q("SELECT m.subject FROM todos t JOIN mails m ON m.id = t.mail_id WHERE t.text = 'Answer Giulia'");
    assert.deepEqual(todo, { subject: "Budget 2027" });
  }));

test("signed in to the mailbox: search a mail, choose the issue; a dropped .eml asks where", () =>
  withApp({ env: { MAIL_SIMULATOR: "1" } }, async ({ page, base, db }) => {
    // Settings → Outlook: the device code, then signed in.
    await page.goto(base + "/settings/outlook");
    const popup = page.context().waitForEvent("page").catch(() => null);
    await page.getByRole("button", { name: "Sign in to Microsoft" }).click();
    await page.getByTestId("mail-user-code").waitFor();
    await (await popup)?.close();
    await page.getByText("Signed in as Mario Rossi").waitFor({ timeout: 15_000 });

    // From the palette: the mailbox searched, then where it goes.
    await page.goto(base + "/");
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("option", { name: "Pin a mail…" }).click();
    const dialog = page.getByRole("dialog", { name: "Pin a mail" });
    await dialog.getByRole("textbox", { name: "Search your mailbox" }).fill("budget");
    await dialog.getByRole("region", { name: "In your mailbox" }).getByRole("button", { name: /Budget 2027/ }).click();
    const where = page.getByRole("dialog", { name: "Where does it go?" });
    await where.getByRole("textbox", { name: "Search an issue (key or words)" }).fill("Test task number 2");
    await where.getByRole("button", { name: /DEMO-102/ }).click();
    await where.waitFor({ state: "detached" });
    assert.deepEqual(await db.q("SELECT m.subject, m.source, m.internet_message_id, m.web_link LIKE 'https://outlook.office.com/mail/deeplink/read/%' AS linked, l.issue_key FROM mails m JOIN mail_links l ON l.mail_id = m.id"), [
      { subject: "Budget 2027", source: "graph", internet_message_id: "sim-2@example.com", linked: true, issue_key: "DEMO-102" },
    ]);

    // An .eml dropped anywhere: its link found in the mailbox, a TODO about it.
    const data = await page.evaluateHandle(text => {
      const d = new DataTransfer();
      d.items.add(new File([text], "kickoff.eml", { type: "message/rfc822" }));
      return d;
    }, ["From: Marco Verdi <marco@example.com>", "Subject: Kick-off notes", "Message-ID: <sim-1@example.com>", "", "body"].join("\r\n"));
    const main = page.locator("main").first();
    await main.dispatchEvent("dragover", { dataTransfer: data });
    await main.dispatchEvent("drop", { dataTransfer: data });
    await where.getByRole("button", { name: "New TODO about it" }).click();
    await where.waitFor({ state: "detached" });
    assert.deepEqual(await db.q("SELECT t.text, m.web_link IS NOT NULL AS linked FROM todos t JOIN mails m ON m.id = t.mail_id"), [{ text: "Kick-off notes", linked: true }]);
  }));

test("a note: a mail pinned under it, its link written where the cursor is", () =>
  withApp(
    {
      seed: async db => {
        const now = Date.now();
        await db.q(
          "INSERT INTO markdown_notes (id, user_id, title, body, body_text, search_title, search_text, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 1, 'Release plan', 'Ask Giulia: ', 'Ask Giulia:', 'release plan', 'ask giulia', ?, ?)",
          now,
          now,
        );
        await db.q(
          "INSERT INTO mails (user_id, subject, from_name, web_link, internet_message_id, source, created_at, updated_at) VALUES (1, 'Budget [2027]', 'Giulia', ?, 'b@x', 'graph', ?, ?)",
          `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(ID)}`,
          now,
          now,
        );
      },
    },
    async ({ page, base, db }) => {
      await page.goto(base + "/notes/11111111-1111-4111-8111-111111111111?view=edit");
      const body = page.getByRole("textbox", { name: "Markdown" });
      await body.waitFor();
      await body.click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.getByRole("button", { name: "Pin a mail" }).click();
      const dialog = page.getByRole("dialog", { name: "Pin a mail" });
      await dialog.getByRole("button", { name: /Budget \[2027\]/ }).click();
      await dialog.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Write the link to Budget [2027] in the note" }).waitFor();
      assert.equal(await body.inputValue(), `Ask Giulia: [✉ Budget \\[2027\\]](https://outlook.office.com/mail/deeplink/read/${encodeURIComponent(ID)})`);
      assert.deepEqual(await db.q("SELECT note_id FROM mail_links"), [{ note_id: "11111111-1111-4111-8111-111111111111" }]);
    },
  ));
