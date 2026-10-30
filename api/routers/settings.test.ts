import { jiraSignIn } from "../testing/signIn";
import { describe, it, expect, beforeAll, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const who = url.includes("other") ? "acc-2" : "acc-1";
    return new Response(JSON.stringify({ accountId: who, displayName: "Mario", avatarUrls: {} }), {
      headers: { "Content-Type": "application/json" },
    });
  }),
);

async function callerFor(site: string) {
  const { appRouter } = await import("../router");
  const resHeaders = new Headers();
  await jiraSignIn({ req: new Request("http://localhost/"), resHeaders }, { siteUrl: site, deployment: "cloud", authType: "basic", username: "m@x.it", secret: "t" });
  const cookie = (resHeaders.get("set-cookie") ?? "").split(";")[0];
  const { userFromRequest } = await import("../context");
  const ctx = await userFromRequest(new Request("http://localhost/", { headers: { cookie } }));
  return appRouter.createCaller({
    req: new Request("http://localhost/"),
    resHeaders: new Headers(),
    user: ctx.user,
    sessionId: ctx.sessionId,
  });
}

describe("settings: allowed link domains", () => {
  let me: Awaited<ReturnType<typeof callerFor>>;

  beforeAll(async () => {
    const conn = await import("../queries/connection");
    await conn.resetDbForTests();
    me = await callerFor("https://acme.atlassian.net");
  });

  it("starts empty, stores normalized unique domains, sorted", async () => {
    expect((await me.settings.get()).allowedLinkDomains).toEqual([]);
    const s = await me.settings.update({
      allowedLinkDomains: ["https://Drive.Google.com/file/1", "*.atlassian.net", "google.com", "drive.google.com"],
    });
    expect(s.allowedLinkDomains).toEqual(["atlassian.net", "drive.google.com", "google.com"]);
  });

  it("refuses what is not a domain", async () => {
    await expect(me.settings.update({ allowedLinkDomains: ["javascript:alert(1)"] })).rejects.toThrow();
    await expect(me.settings.update({ allowedLinkDomains: ["localhost"] })).rejects.toThrow();
  });

  it("an update without the field keeps them", async () => {
    const s = await me.settings.update({ idleMinutes: 15 });
    expect(s.allowedLinkDomains).toContain("google.com");
  });

  it("the pinboard lives in all three places until one is switched off, alone", async () => {
    expect(await me.settings.get()).toMatchObject({ pinboardOnBoard: 1, pinboardInMenu: 1, pinboardWidget: 1 });
    expect(await me.settings.update({ pinboardWidget: false })).toMatchObject({ pinboardOnBoard: 1, pinboardInMenu: 1, pinboardWidget: 0 });
    expect(await me.settings.update({ pinboardOnBoard: false, pinboardWidget: true })).toMatchObject({ pinboardOnBoard: 0, pinboardInMenu: 1, pinboardWidget: 1 });
    expect(await me.settings.update({ idleMinutes: 20 })).toMatchObject({ pinboardOnBoard: 0, pinboardInMenu: 1, pinboardWidget: 1 });
  });
});

describe("settings: mail copies", () => {
  it("mail copies need consent", async () => {
    const me = await callerFor("https://consent.atlassian.net");
    expect((await me.settings.get()).mailCopies).toBe("off");
    await expect(me.settings.update({ mailCopies: "body" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "Keeping copies of your mails needs your consent first.",
    });
    expect((await me.settings.get()).mailCopies).toBe("off");
    const on = await me.settings.update({ mailCopies: "body", mailCopiesConsent: true });
    expect(on.mailCopies).toBe("body");
    expect(on.mailCopiesConsentAt).toBeInstanceOf(Date);
    // Given once: moving between modes, or off and back, doesn't ask again.
    expect((await me.settings.update({ mailCopies: "full" })).mailCopies).toBe("full");
    await me.settings.update({ mailCopies: "off" });
    expect((await me.settings.update({ mailCopies: "body" })).mailCopies).toBe("body");
    // The server's kill switch wins over any consent.
    const { env } = await import("../lib/env");
    env.mailCopies = false;
    try {
      await expect(me.settings.update({ mailCopies: "full" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "Copies of mails are turned off on this server." });
      // Off is always allowed.
      expect((await me.settings.update({ mailCopies: "off" })).mailCopies).toBe("off");
    } finally {
      env.mailCopies = true;
    }
  });
});

