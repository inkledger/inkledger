// Pinned mails: a pasted Outlook link, a dropped .eml file, the pinboard and a TODO about a mail.
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
    await dialog.getByRole("textbox", { name: "Subject" }).fill("Release 2.3");
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
