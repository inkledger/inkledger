// Chats about an issue between teammates (docs/work/issue-chat.md): opened from the issue with a teammate the
// tracker shows it to, read live by the other side (typing, "seen", files), resolved; nobody else reaches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { withApp } from "./harness.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000020806000000f478d4fa0000000d49444154789c63f8cfc0f01f0005fe02fea7d6a2bf0000000049454e44ae426082", "hex");

/** This machine's private address: the app never lets a tracker resolve to loopback (api/lib/security.ts). */
function privateAddress() {
  const found = Object.values(networkInterfaces())
    .flat()
    .find(a => a && a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  assert.ok(found, "a private IPv4 address on this machine");
  return found.address;
}

/** A Jira Server with DEMO-101 (shown to every account) and one comment on it. */
async function fakeJira() {
  const host = privateAddress();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (body, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.endsWith("/issue/DEMO-101"))
      return send({
        id: "DEMO-101",
        key: "DEMO-101",
        fields: {
          summary: "Test task number 1",
          status: { id: "1", name: "To Do", statusCategory: { key: "new" } },
          project: { key: "DEMO", name: "Project" },
          issuetype: { name: "Task" },
          priority: { name: "Medium" },
          labels: [],
          components: [],
          assignee: null,
          updated: "2026-11-20T09:00:00.000+0000",
          created: "2026-11-01T09:00:00.000+0000",
        },
      });
    if (url.pathname.endsWith("/issue/DEMO-101/comment"))
      return send({ startAt: 0, total: 1, comments: [{ id: "900", author: { displayName: "Anna Analyst" }, created: "2026-11-20T09:00:00.000+0000", body: "The totals exclude VAT." }] });
    send({ errorMessages: [`fake: ${req.method} ${url.pathname}`] }, 404);
  });
  await new Promise(resolve => server.listen(0, host, resolve));
  return { url: `http://${host}:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

const hash = c => createHash("sha256").update(c).digest("hex");

test("a teammate is asked about an issue, reads and answers live; nobody else reaches the chat", async () => {
  const jira = await fakeJira();
  const giuliaCookie = randomBytes(32).toString("base64url");
  const carloCookie = randomBytes(32).toString("base64url");
  try {
    await withApp(
      {
        seed: async db => {
          const now = Date.now();
          await db.q("UPDATE connections SET base_url = ? WHERE id = 1", jira.url);
          await db.q("INSERT INTO users (id, username, role, email, display_name, created_at) VALUES (2, 'gverdi', 'member', 'gverdi', 'Giulia Verdi', ?), (3, 'cbianchi', 'member', 'cbianchi', 'Carlo Bianchi', ?)", now, now);
          await db.q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 2, ?, ?), (?, 3, ?, ?)", hash(giuliaCookie), now + 86_400_000, now, hash(carloCookie), now + 86_400_000, now);
          // Giulia on the same Jira (Mario's sealed secret works for any connection in the legacy format the harness writes).
          await db.q(
            "INSERT INTO connections (id, user_id, type, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) SELECT 2, 2, 'jira', base_url, 'gverdi', 'Giulia Verdi', options, encrypted_secret, ? FROM connections WHERE id = 1",
            now,
          );
          await db.q("INSERT INTO sync_state (user_id, last_sync_at, last_full_sync_at) VALUES (2, ?, ?), (3, ?, ?)", now, now, now, now);
          await db.q("INSERT INTO connection_sync (connection_id, stream, last_ok_at, last_full_at) VALUES (2, 'issues', ?, ?)", now, now);
          // Mario and Giulia share a team; Carlo is in none.
          await db.q("INSERT INTO teams (id, name, created_at) VALUES (1, 'Analysis', ?)", now);
          await db.q("INSERT INTO team_members (team_id, user_id, role) VALUES (1, 1, 'member'), (1, 2, 'member')");
        },
      },
      async ({ page, context, base, errors, db }) => {
        const port = new URL(base).port;
        const open = async cookie => {
          const ctx = await context.browser().newContext({ locale: "en-US", timezoneId: "Europe/Rome", viewport: { width: 1400, height: 900 } });
          await ctx.addCookies([{ name: `ikl_session_${port}`, value: cookie, url: base }]);
          const p = await ctx.newPage();
          p.on("pageerror", e => errors.push(String(e)));
          return { ctx, p };
        };
        const { ctx: giuliaCtx, p: giulia } = await open(giuliaCookie);
        const { ctx: carloCtx, p: carlo } = await open(carloCookie);
        try {
          // Mario, on the issue: "Chat about this issue" lists his teammate, not Carlo.
          await page.goto(base + "/issues/DEMO-101");
          await page.getByRole("heading", { name: /Test task number 1/ }).first().waitFor();
          await page.getByRole("button", { name: "Chat about this issue" }).first().click();
          const picker = page.getByRole("dialog", { name: "Chat about DEMO-101" });
          await picker.waitFor();
          const giuliaRow = picker.getByRole("button", { name: /Giulia Verdi/ });
          await giuliaRow.waitFor();
          assert.equal(await picker.getByRole("button", { name: /Carlo Bianchi/ }).count(), 0);
          await giuliaRow.click();
          assert.equal(await giuliaRow.getAttribute("aria-pressed"), "true");
          await picker.getByRole("textbox", { name: /First message/ }).fill("Is the export blocked by the VAT change?");
          await picker.getByRole("button", { name: "Start chat" }).click();
          await page.waitForURL(/\/notifications\?tab=chat&thread=\d+/);
          const marioThread = page.locator("[data-chat-thread]");
          await marioThread.getByText("Is the export blocked by the VAT change?").waitFor();
          // Beside the list (wide), no way "back" to it: it is there.
          assert.equal(await marioThread.getByRole("button", { name: "Chats" }).count(), 0);
          const [{ id: threadId }] = await db.q("SELECT id FROM chat_threads");

          // Giulia: the bell counts it, the Chat tab says it, the list shows it unread.
          await giulia.goto(base + "/notifications");
          // The tab says how many messages wait (once its count has loaded).
          const chatTab = giulia.getByRole("tab", { name: /^Chat\s*1$/ });
          await chatTab.waitFor();
          await chatTab.click();
          await giulia.waitForURL(/tab=chat/);
          const row = giulia.locator(`[data-thread-id="${threadId}"] button`);
          await row.waitFor();
          assert.match(await row.innerText(), /DEMO-101/);
          await row.click();
          const herThread = giulia.locator("[data-chat-thread]");
          await herThread.getByText("Is the export blocked by the VAT change?").waitFor();

          // Mario sees she has read it.
          await marioThread.getByLabel("Seen by Giulia Verdi").waitFor();

          // She types: he sees it. She answers: it arrives without a reload.
          const box = herThread.getByRole("textbox", { name: "Message" });
          await box.fill("Yes");
          await box.press("End");
          await box.type(", since Monday");
          await marioThread.getByText("Giulia Verdi is typing…").waitFor();
          await box.press("Enter");
          await marioThread.getByText("Yes, since Monday").waitFor();

          // A screenshot: uploaded, sent, seen by Mario, opened in the viewer.
          await herThread.locator('input[type="file"]').setInputFiles({ name: "export.png", mimeType: "image/png", buffer: PNG });
          await herThread.getByText("export.png").waitFor();
          await herThread.getByRole("button", { name: "Send" }).click();
          const picture = marioThread.getByRole("button", { name: "export.png" });
          await picture.waitFor();
          await picture.click();
          await page.getByRole("dialog", { name: "export.png" }).waitFor();
          await page.keyboard.press("Escape");
          const [file] = await db.q("SELECT id FROM chat_files");

          // Mario resolves it: the line reaches Giulia.
          await marioThread.getByRole("button", { name: "Chat actions" }).click();
          await page.getByRole("menuitem", { name: "Mark resolved" }).click();
          await herThread.getByText(/Mario Rossi marked it resolved/).waitFor();

          // Carlo, signed in but no member: the chat and its file read as missing.
          await carlo.goto(base + "/notifications?tab=chat");
          const status = await carlo.evaluate(async ([t, f]) => {
            const file = await fetch(`/api/chat/files/${f}`);
            const thread = await fetch(`/api/trpc/chat.thread?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: { threadId: t } } }))}`);
            return [file.status, thread.status];
          }, [threadId, file.id]);
          assert.deepEqual(status, [404, 404]);

          // At 320 px the chat fits: nothing scrolls sideways.
          await giulia.setViewportSize({ width: 320, height: 720 });
          // Narrow, the list again (the chat picked beside it is the selection); opened, it replaces the list.
          await row.click();
          await herThread.getByText("Yes, since Monday").waitFor();
          await herThread.getByRole("textbox", { name: "Message" }).waitFor();
          // The composer is on screen and nothing (the tab bar) lies over it.
          // Its whole box (not just its middle) ends above the tab bar, once the header has settled.
          await giulia.waitForTimeout(300);
          const reach = await giulia.evaluate(() => {
            const composer = document.querySelector("[data-chat-composer]").getBoundingClientRect();
            const box = document.querySelector("[data-chat-composer] textarea");
            const r = box.getBoundingClientRect();
            const bar = document.querySelector("[data-tab-bar]")?.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.bottom - 2);
            return { aboveBar: composer.bottom <= (bar ? bar.top : innerHeight), inView: r.top >= 0, onTop: hit === box };
          });
          assert.deepEqual(reach, { aboveBar: true, inView: true, onTop: true });
          const overflow = await giulia.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth);
          assert.ok(overflow <= 0, `no sideways scroll at 320 px (${overflow}px)`);
        } finally {
          await giuliaCtx.close();
          await carloCtx.close();
        }
      },
    );
  } finally {
    await jira.close();
  }
});

test("a tracker comment is discussed in a chat that quotes it", async () => {
  const jira = await fakeJira();
  try {
    await withApp(
      {
        seed: async db => {
          const now = Date.now();
          await db.q("UPDATE connections SET base_url = ? WHERE id = 1", jira.url);
          await db.q("INSERT INTO users (id, username, role, email, display_name, created_at) VALUES (2, 'gverdi', 'member', 'gverdi', 'Giulia Verdi', ?)", now);
          await db.q("INSERT INTO connections (id, user_id, type, base_url, remote_account_id, display_name, options, encrypted_secret, created_at) SELECT 2, 2, 'jira', base_url, 'gverdi', 'Giulia Verdi', options, encrypted_secret, ? FROM connections WHERE id = 1", now);
          await db.q("INSERT INTO teams (id, name, created_at) VALUES (1, 'Analysis', ?)", now);
          await db.q("INSERT INTO team_members (team_id, user_id, role) VALUES (1, 1, 'member'), (1, 2, 'member')");
        },
      },
      async ({ page, base, db }) => {
        await page.goto(base + "/issues/DEMO-101");
        await page.getByText("The totals exclude VAT.").first().waitFor();
        await page.getByRole("button", { name: "Discuss this comment with a teammate" }).first().click();
        const picker = page.getByRole("dialog", { name: "Chat about DEMO-101" });
        await picker.getByRole("button", { name: /Giulia Verdi/ }).click();
        await picker.getByRole("button", { name: "Start chat" }).click();
        await page.waitForURL(/tab=chat&thread=/);
        const thread = page.locator("[data-chat-thread]");
        await thread.getByText("The totals exclude VAT.").waitFor();
        await thread.getByText(/Comment by Anna Analyst/).waitFor();
        const [m] = await db.q("SELECT refs FROM chat_messages WHERE kind = 'text'");
        assert.equal(JSON.parse(m.refs)[0].commentId, "900");
      },
    );
  } finally {
    await jira.close();
  }
});
