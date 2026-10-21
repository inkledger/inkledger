// Checking a Jira login live (activating an account, connecting Jira): the
// URL is vetted, Jira confirms who the credentials belong to, and every
// failure gets one answer, so the form can't be used to probe hosts.
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

export async function confirmJiraLogin(input: JiraLoginInput): Promise<JiraIdentity> {
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
    console.warn(
      `[auth] Jira login to ${input.siteUrl} failed: ${
        err instanceof JiraApiError
          ? `HTTP ${err.status} ${err.message}`
          : isNetworkError(err)
            ? `network ${err instanceof Error ? err.message : String(err)}`
            : err instanceof Error
              ? err.message
              : String(err)
      }`,
    );
    if (err instanceof JiraApiError && (err.status === 401 || err.status === 403)) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: input.deployment === "server" ? t("server.auth.invalidCredentialsServer") : t("server.auth.invalidCredentialsCloud"),
      });
    }
    throw new TRPCError({ code: "BAD_REQUEST", message: t("server.auth.loginFailed") });
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
