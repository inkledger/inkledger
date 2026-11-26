// Feedback in the browser: sent from the account menu, followed in Info › Feedback, its state
// changed by an admin and seen by its author; Back keeps the list's filters and place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { withApp } from "./harness.mjs";

test("sent from the account menu, listed as mine, moved by an admin, seen by its author; Back keeps the place", () => {
  const cookie = randomBytes(32).toString("base64url");
  return withApp(
    {
      seed: async db => {
        const now = Date.now();
        await db.q("INSERT INTO users (id, username, role, email, display_name, created_at) VALUES (2, 'gverdi', 'member', 'gverdi', 'Giulia Verdi', ?)", now);
        await db.q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, 2, ?, ?)", createHash("sha256").update(cookie).digest("hex"), now + 86_400_000, now);
      },
    },
    async ({ page, context, base, db, errors }) => {
      // Giulia, on her own browser.
      const hers = await context.browser().newContext({ locale: "en-US", timezoneId: "Europe/Rome", viewport: { width: 1400, height: 900 } });
      try {
        await hers.addCookies([{ name: `ikl_session_${new URL(base).port}`, value: cookie, url: base }]);
        const giulia = await hers.newPage();
        giulia.on("pageerror", e => errors.push(String(e)));
        await giulia.goto(base + "/timesheet");
        await giulia.getByRole("button", { name: "Account menu" }).first().click();
        await giulia.getByRole("menuitem", { name: "Send feedback" }).click();
        const sheet = giulia.getByRole("dialog", { name: "Send feedback" });
        await sheet.waitFor();
        // What goes with it is shown: the page it came from.
        await sheet.getByText("/timesheet").waitFor();
        await sheet.getByRole("radio", { name: "Idea" }).click();
        await sheet.getByLabel("Title").fill("A weekly total in the header");
        await sheet.getByLabel("Description").fill("I'd like the week's hours beside the title.");
        await sheet.getByRole("button", { name: "Send" }).click();
        await sheet.waitFor({ state: "detached" });
        await giulia.getByText("Feedback sent").waitFor();

        // Info › Feedback: hers, new.
        await giulia.goto(base + "/info/feedback");
        const list = giulia.getByRole("list", { name: "Feedback" });
        const row = list.getByRole("link", { name: /A weekly total in the header/ });
        await row.waitFor();
        assert.match(await row.innerText(), /New/);
        const [stored] = await db.q("SELECT id, user_id, type, page, share_state FROM feedback");
        assert.deepEqual({ ...stored, id: undefined }, { id: undefined, user_id: 2, type: "idea", page: "/timesheet", share_state: null });

        // Mario (an owner) sees everyone's; filtered to new ones, he opens hers and accepts it.
        await page.goto(base + "/info/feedback?scope=all");
        await page.getByRole("combobox", { name: "State" }).first().click();
        await page.getByRole("option", { name: "New" }).click();
        await page.waitForURL(/status=new/);
        const theirs = page.getByRole("list", { name: "Feedback" }).getByRole("link", { name: /A weekly total in the header/ });
        await theirs.click();
        await page.waitForURL(new RegExp(`/info/feedback/${stored.id}\\?.*status=new`));
        const detail = page.getByRole("article");
        await detail.getByRole("heading", { name: "A weekly total in the header" }).waitFor();
        await detail.getByRole("combobox", { name: "State" }).click();
        await page.getByRole("option", { name: "Accepted" }).click();
        await detail.getByRole("button", { name: "Change state" }).click();
        await page.getByText("State changed").waitFor();
        await detail.getByText("New → Accepted").waitFor();

        // Back: the list as it was, its filter kept.
        await page.goBack();
        await page.waitForURL(u => u.pathname === "/info/feedback" && u.searchParams.get("status") === "new" && u.searchParams.get("scope") === "all");
        assert.match(await page.getByRole("combobox", { name: "State" }).first().innerText(), /New/);

        // Giulia sees it accepted, and was told.
        await giulia.reload();
        await row.waitFor();
        await row.filter({ hasText: "Accepted" }).waitFor();
        const told = await db.q("SELECT detail FROM notifications WHERE user_id = 2 AND kind = 'alert'");
        assert.equal(told.length, 1);
        assert.deepEqual(JSON.parse(told[0].detail), { kind: "feedback", name: "A weekly total in the header", ref: stored.id, what: "status" });
        await row.click();
        await giulia.getByRole("article").getByText("New → Accepted").waitFor();
      } finally {
        await hers.close();
      }
    },
  );
});
