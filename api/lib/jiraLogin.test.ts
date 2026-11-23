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
});
