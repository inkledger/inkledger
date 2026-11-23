import { afterEach, describe, expect, it } from "vitest";
import { setLocaleSource } from "@contracts/i18n/core";
import { tIn } from "@contracts/i18n";
import { syncFailureText } from "./syncFailure";

describe("a recorded sync failure, as the user reads it", () => {
  afterEach(() => setLocaleSource(() => undefined));

  it("is a sentence in the user's language, not the recorded kind and status", () => {
    setLocaleSource(() => "it");
    const shown = syncFailureText("unavailable (503): Jira answered 503");
    expect(shown).toBe(tIn("it", "ui.syncFailure.serverError"));
    expect(shown).not.toMatch(/unavailable|503/);
    expect(syncFailureText("auth (401): Unauthorized")).toBe("le credenziali salvate sono state rifiutate");
    expect(syncFailureText("timeout: No answer in time")).toBe(tIn("it", "ui.syncFailure.timeout"));
  });

  it("tells a CAPTCHA from refused credentials, and no answer from a server error", () => {
    setLocaleSource(() => "en");
    expect(syncFailureText("auth (401): Jira refused the sign-in (CAPTCHA_CHALLENGE): sign in to Jira in a browser, then reconnect")).toBe(tIn("en", "ui.syncFailure.signInDenied"));
    expect(syncFailureText("unavailable: fetch failed")).toBe(tIn("en", "ui.syncFailure.unavailable"));
  });

  it("text recorded without a kind (older rows) is a generic sentence", () => {
    setLocaleSource(() => "en");
    expect(syncFailureText("fetch failed")).toBe(tIn("en", "ui.syncFailure.other"));
    expect(syncFailureText("Something: else")).toBe(tIn("en", "ui.syncFailure.other"));
  });
});
