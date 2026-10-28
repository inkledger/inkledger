// The Outlook add-in's task pane, with Office.js played by a stub (Outlook is
// not here): the key asked once, the open mail pinned to an issue and a TODO,
// where it is pinned shown, the pinned pane following the mail selected, a
// revoked key asking again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { start } from "./harness.mjs";

const KEY = "ikl_ol_" + "k".repeat(43);

/** Office.js as the pane uses it: one mail open, roaming settings, ItemChanged. */
const OFFICE = `
  const mail = (n, subject) => ({
    itemId: "AAMkAGI2T/EST+" + n + "AAA=",
    subject,
    from: { displayName: "Giulia Rossi", emailAddress: "giulia@example.com" },
    dateTimeCreated: new Date("2026-10-27T09:00:00Z"),
    internetMessageId: "<mail-" + n + "@example.com>",
  });
  const stored = JSON.parse(sessionStorage.getItem("roaming") || "{}");
  window.__mail = mail;
  window.Office = {
    context: {
      displayLanguage: "en-US",
      roamingSettings: {
        get: k => stored[k],
        set: (k, v) => { stored[k] = v; },
        saveAsync: done => { sessionStorage.setItem("roaming", JSON.stringify(stored)); done(); },
      },
      mailbox: {
        item: mail(1, "Budget 2027"),
        convertToRestId: id => id.replace(/\\//g, "-").replace(/\\+/g, "_"),
        addHandlerAsync: (type, handler) => { window.__itemChanged = handler; },
      },
    },
    MailboxEnums: { RestVersion: { v2_0: "v2.0" } },
    EventType: { ItemChanged: "olkItemSelectedChanged" },
    onReady: ready => setTimeout(ready, 10),
  };
`;

/** Nothing drawn past the pane's right edge (Outlook's panes are narrow: nothing may need a sideways scroll). */
async function fitsWidth(page) {
  const over = await page.evaluate(() =>
    [...document.querySelectorAll("#root *")]
      .filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > window.innerWidth + 0.5)
      .map(el => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`),
  );
  assert.deepEqual(over, [], "elements past the pane's width");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll");
}

test("the task pane: key once, pin to an issue and a TODO, where it is pinned, the next mail, a revoked key", async () => {
  const app = await start({ viewport: { width: 320, height: 800 } });
  try {
    const { page, base, db } = app;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await page.route("https://appsforoffice.microsoft.com/**", r => r.fulfill({ body: OFFICE, contentType: "text/javascript" }));
    // Add-ins installed from the first manifest still open the pane.
    await page.goto(base + "/api/outlook/taskpane.html");
    assert.equal(new URL(page.url()).pathname, "/outlook.html");

    // Asked once; a text that is not a key is refused before any call.
    const key = page.getByLabel("Add-in key");
    await key.fill("hello");
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText(/That is not an add-in key/).waitFor();
    await db.q("INSERT INTO mail_addin_keys (user_id, key_hash, created_at) VALUES (1, ?, 1)", createHash("sha256").update(KEY).digest("hex"));
    await key.fill(KEY);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText("Budget 2027", { exact: true }).waitFor();
    await page.getByText(/^Giulia Rossi · /).waitFor();
    await page.getByText(/^Pin this pane/).waitFor();
    // A long issue title and key never widen the pane.
    await db.q("UPDATE issues SET summary = ? WHERE key = 'SHOP-7'", "A very long title ".repeat(12));
    await page.getByRole("searchbox", { name: "Search an issue (key or words)" }).fill("very long title");
    await page.getByRole("button", { name: /SHOP-7/ }).waitFor();
    await fitsWidth(page);

    // To an issue, searched: the pane then says where the mail is.
    await page.getByRole("searchbox", { name: "Search an issue (key or words)" }).fill("number 3");
    await page.getByRole("button", { name: /DEMO-103/ }).click();
    await page.getByText("Pinned to DEMO-103").waitFor();
    await page.getByText("Pinned already: DEMO-103").waitFor();
    await page.getByRole("button", { name: /DEMO-103/, pressed: true }).waitFor();

    // A TODO about it, due tomorrow.
    await page.getByRole("combobox", { name: "When" }).click();
    await page.getByRole("option", { name: "Tomorrow" }).click();
    await page.getByRole("button", { name: "Add TODO" }).click();
    await page.getByText("Pinned already: DEMO-103 · TODO “Budget 2027”").waitFor();
    const tomorrow = await page.evaluate(() => {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      return d.toLocaleDateString("sv-SE");
    });
    assert.deepEqual(await db.q("SELECT text, due_on FROM todos"), [{ text: "Budget 2027", due_on: tomorrow }]);

    // On a new board, named here: then it is the board chosen.
    await page.getByRole("combobox", { name: "Which board" }).click();
    await page.getByRole("option", { name: "New board…" }).click();
    await page.getByRole("textbox", { name: "Name of the new board" }).fill("Mails");
    await fitsWidth(page);
    await page.getByRole("button", { name: "Pin here" }).click();
    await page.getByText("On the board Mails").waitFor();
    await page.getByRole("combobox", { name: "Which board" }).filter({ hasText: "Mails" }).waitFor();
    assert.deepEqual(await db.q("SELECT b.name FROM pinboard_notes n JOIN pinboards b ON b.id = n.board_id WHERE n.mail_id IS NOT NULL"), [{ name: "Mails" }]);
    const [m] = await db.q("SELECT subject, source, internet_message_id, web_link FROM mails");
    assert.deepEqual(m, {
      subject: "Budget 2027",
      source: "addin",
      internet_message_id: "mail-1@example.com",
      web_link: `https://outlook.office.com/mail/deeplink/read/${encodeURIComponent("AAMkAGI2T-EST_1AAA=")}`,
    });

    // Pinned pane, another mail selected: it follows, nothing pinned for that one yet; the pin tip goes.
    await page.evaluate(() => {
      window.Office.context.mailbox.item = window.__mail(2, "Kick-off notes");
      window.__itemChanged({ type: "olkItemSelectedChanged" });
    });
    await page.getByText("Kick-off notes", { exact: true }).waitFor();
    assert.equal(await page.getByTestId("pinned-already").count(), 0);
    assert.equal(await page.getByText(/^Pin this pane/).count(), 0);
    // Its link copied: Markdown to the mail, and the mail kept in inkledger.
    await page.getByRole("button", { name: "Copy link" }).click();
    await page.getByText(/^Link copied/).waitFor();
    assert.equal(await page.locator("#clip").inputValue(), `[✉ Kick-off notes](https://outlook.office.com/mail/deeplink/read/${encodeURIComponent("AAMkAGI2T-EST_2AAA=")})`);
    for (let i = 0; i < 50 && (await db.q("SELECT count(*)::int AS n FROM mails"))[0].n < 2; i++) await page.waitForTimeout(100);
    assert.deepEqual(await db.q("SELECT subject FROM mails ORDER BY id"), [{ subject: "Budget 2027" }, { subject: "Kick-off notes" }]);

    // No mail selected (several, or none): nothing to pin.
    await page.evaluate(() => {
      window.Office.context.mailbox.item = null;
      window.__itemChanged({ type: "olkItemSelectedChanged" });
    });
    await page.getByText("Open a mail to pin it.").waitFor();
    assert.equal(await page.getByRole("button", { name: "Copy link" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Add TODO" }).count(), 0);

    // A wider pane uses its width, still nothing past it.
    await page.setViewportSize({ width: 480, height: 800 });
    await fitsWidth(page);

    // The key revoked in Settings: asked again, saying why.
    await db.q("DELETE FROM mail_addin_keys");
    await page.reload();
    await page.getByLabel("Add-in key").waitFor();
    await page.getByText(/This add-in key is not valid any more/).waitFor();
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
  }
});
