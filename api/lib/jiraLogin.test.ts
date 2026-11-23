import { afterEach, describe, expect, it, vi } from "vitest";

// Redirect targets and the site are checked with a DNS lookup: no real DNS in tests.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

describe("confirmJiraLogin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a sign-in Jira denies (CAPTCHA) says so: typing the password again would only be another failed login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html></html>", { status: 403, headers: { "Content-Type": "text/html", "X-Seraph-LoginReason": "AUTHENTICATION_DENIED", "X-Authentication-Denied-Reason": "CAPTCHA_CHALLENGE; login-url=https://acme.atlassian.net/login.jsp" } })),
    );
    const { confirmJiraLogin } = await import("./jiraLogin");
    const { t } = await import("@contracts/i18n");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(confirmJiraLogin({ siteUrl: "https://acme.atlassian.net", deployment: "server", authType: "basic", username: "mario", secret: "pw" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: t("server.auth.signInDenied"),
    });
  });

  describe("every refusal says why, and the log names Jira's reason (never the secret)", () => {
    const server = { siteUrl: "https://acme.atlassian.net", deployment: "server" as const, authType: "basic" as const, username: "mario", secret: "s3cret-pw" };
    const page = (status: number, headers: Record<string, string> = {}) => new Response("<html></html>", { status, headers: { "Content-Type": "text/html", ...headers } });
    const refused = async (answer: () => Response | Promise<Response>, opts = {}) => {
      vi.stubGlobal("fetch", vi.fn(async () => answer()));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { confirmJiraLogin } = await import("./jiraLogin");
      const e = await confirmJiraLogin(server, opts).catch((x: unknown) => x);
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      warn.mockRestore();
      expect(logged).not.toContain("s3cret-pw");
      return { e: e as { code?: string; message?: string }, logged };
    };

    it("a CAPTCHA on a 401 (the live case): the steps, and the Seraph header in the log", async () => {
      const { t } = await import("@contracts/i18n");
      const { e, logged } = await refused(() => page(401, { "X-Seraph-LoginReason": "AUTHENTICATION_DENIED", "X-Authentication-Denied-Reason": "CAPTCHA_CHALLENGE; login-url=https://acme.atlassian.net/login.jsp" }));
      expect(e).toMatchObject({ code: "UNAUTHORIZED", message: t("server.auth.signInDenied") });
      expect(e.message).toMatch(/Sign out of Jira/);
      expect(logged).toMatch(/\(captcha\).*X-Seraph-LoginReason: AUTHENTICATION_DENIED/);
    });

    it("a wrong password; the same after a CAPTCHA may still be the CAPTCHA", async () => {
      const { t } = await import("@contracts/i18n");
      const wrong = () => page(401, { "X-Seraph-LoginReason": "AUTHENTICATED_FAILED" });
      const first = await refused(wrong);
      expect(first.e).toMatchObject({ code: "UNAUTHORIZED", message: t("server.auth.invalidCredentialsServer") });
      expect(first.logged).toMatch(/\(credentials\).*AUTHENTICATED_FAILED/);
      expect((await refused(wrong, { captchaBefore: true, refusedCode: "PRECONDITION_FAILED" })).e).toMatchObject({ code: "PRECONDITION_FAILED", message: t("server.auth.captchaMaybe") });
    });

    it("an account Jira won't let in, an SSO's sign-in page, Jira out of reach", async () => {
      const { t } = await import("@contracts/i18n");
      expect((await refused(() => page(401, { "X-Seraph-LoginReason": "AUTHORISATION_FAILED" }))).e).toMatchObject({ message: t("server.auth.jiraNoAccess") });
      const sso = page(200);
      Object.defineProperty(sso, "url", { value: "https://acme.atlassian.net/login.jsp?os_destination=%2Frest%2Fapi%2F2%2Fmyself" });
      expect((await refused(() => sso)).e).toMatchObject({ message: t("server.auth.jiraSsoPage") });
      for (const down of [() => page(503), () => Promise.reject(new TypeError("fetch failed"))]) {
        const { e, logged } = await refused(down);
        expect(e).toMatchObject({ code: "BAD_REQUEST", message: t("server.auth.jiraUnreachable") });
        expect(logged).toMatch(/\(unreachable\)/);
      }
    });
  });
});
