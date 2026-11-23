// Checking a Jira login live (activating an account, connecting Jira): the
// URL is vetted, Jira confirms who the credentials belong to, and a refusal
// says Jira's own reason; any other failure on a typed address gets one
// answer, so the form can't be used to probe hosts.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { t } from "@contracts/i18n";
import { getMyself, isNetworkError, JiraApiError } from "../jira/client";
import { assertSafeJiraUrl, UnsafeUrlError } from "./security";
import { normalizeSiteUrl } from "./siteUrl";
import { env } from "./env";

export const jiraLoginInput = z.object({
  siteUrl: z.string().url().transform(normalizeSiteUrl),
  deployment: z.enum(["cloud", "server"]).default("cloud"),
  /** Cloud: email. Server/DC: username */
  username: z.string().min(1),
  /** Cloud: API token. Server: password (basic) or PAT (bearer) */
  secret: z.string().min(1),
  authType: z.enum(["basic", "bearer"]).default("basic"),
});
export type JiraLoginInput = z.infer<typeof jiraLoginInput>;

/** A Jira login confirmed live: who it is there, and the secret for its connection (sealed only there, never on the user). */
export type JiraIdentity = {
  siteUrl: string;
  accountId: string;
  deployment: "cloud" | "server";
  authType: "basic" | "bearer";
  email: string;
  displayName: string;
  avatarUrl: string | null;
  secret: string;
};

/** Why Jira refused a login, as the log and the user are told it (never the secret). */
type Refusal = "captcha" | "noAccess" | "ssoPage" | "credentials" | "unreachable" | "failed";

function refusalOf(err: unknown): Refusal {
  if (isNetworkError(err)) return "unreachable";
  if (!(err instanceof JiraApiError)) return "failed";
  if (err.signInDenied) return "captcha";
  if (err.signInPage) return "ssoPage";
  // Seraph knew the password but the account may not use Jira (deactivated, no application access).
  if (/AUTHORISATION_FAILED/.test(err.loginReason ?? "")) return "noAccess";
  if (err.status === 401 || err.status === 403) return "credentials";
  return err.status >= 500 ? "unreachable" : "failed";
}

export type ConfirmOptions = {
  /** The tRPC code of a refused login: UNAUTHORIZED signs a signed-in app out, so a connection's form gets another. */
  refusedCode?: "UNAUTHORIZED" | "PRECONDITION_FAILED";
  /** Jira asked this connection for a CAPTCHA before: a bare refusal may still be that, not the password. */
  captchaBefore?: boolean;
  /** A site already connected here: saying it is out of reach probes nothing (a typed address gets the one answer). */
  knownSite?: boolean;
};

export async function confirmJiraLogin(input: JiraLoginInput, opts: ConfirmOptions = {}): Promise<JiraIdentity> {
  try {
    // Jira Cloud is a service on the internet: the self-hosted allowlist doesn't limit it.
    const cloud = /\.atlassian\.net$/i.test(new URL(input.siteUrl).hostname);
    await assertSafeJiraUrl(input.siteUrl, cloud ? [] : env.remoteAllowedHosts);
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    throw err;
  }
  let myself;
  try {
    myself = await getMyself({ siteUrl: input.siteUrl, deployment: input.deployment, authType: input.authType, username: input.username, secret: input.secret });
  } catch (err) {
    const refusal = refusalOf(err);
    console.warn(
      `[auth] Jira login to ${input.siteUrl} failed (${refusal}): ${
        err instanceof JiraApiError
          ? `HTTP ${err.status} ${err.message}${err.loginReason ? ` [X-Seraph-LoginReason: ${err.loginReason}]` : ""}`
          : isNetworkError(err)
            ? `network ${err instanceof Error ? err.message : String(err)}`
            : err instanceof Error
              ? err.message
              : String(err)
      }`,
    );
    const refused = (message: string) => new TRPCError({ code: opts.refusedCode ?? "UNAUTHORIZED", message });
    switch (refusal) {
      // Another try with the same password would be one more failed login: a browser sign-in clears it.
      case "captcha":
        throw refused(t("server.auth.signInDenied"));
      case "noAccess":
        throw refused(t("server.auth.jiraNoAccess"));
      case "ssoPage":
        throw refused(t("server.auth.jiraSsoPage"));
      case "credentials":
        throw refused(
          opts.captchaBefore
            ? t("server.auth.captchaMaybe")
            : input.deployment === "server"
              ? t("server.auth.invalidCredentialsServer")
              : t("server.auth.invalidCredentialsCloud"),
        );
      case "unreachable":
        if (opts.knownSite) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.auth.jiraUnreachable") });
        throw new TRPCError({ code: "BAD_REQUEST", message: t("server.auth.loginFailed") });
      default:
        throw new TRPCError({ code: "BAD_REQUEST", message: t("server.auth.loginFailed") });
    }
  }
  return {
    siteUrl: input.siteUrl,
    // Cloud identifies users by accountId; Server/DC 8.x by username (name/key)
    accountId: myself.accountId ?? myself.name ?? myself.key ?? input.username,
    deployment: input.deployment,
    authType: input.authType,
    email: input.username,
    displayName: myself.displayName,
    avatarUrl: myself.avatarUrls?.["48x48"] ?? null,
    secret: input.secret,
  };
}
