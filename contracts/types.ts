export * from "./time";

export type JiraDeployment = "cloud" | "server";

export type JiraAuthType = "basic" | "bearer";

export type JiraCredentials = {
  siteUrl: string;
  /** "cloud" = Jira Cloud (API v3, email + API token); "server" = Jira Server/DC 8.x (API v2) */
  deployment: JiraDeployment;
  /** Email (Cloud) or username (Server/DC) */
  username: string;
  /** API token (Cloud), password (Server basic) or Personal Access Token (Server bearer) */
  secret: string;
  /** "basic" = Basic auth; "bearer" = Personal Access Token (Server/DC 8.14+ only) */
  authType: JiraAuthType;
};

export const SESSION_COOKIE = "ikl_session";

/** Offline-queue entries failing this many times are no longer replayed. */
export const MAX_OUTBOX_ATTEMPTS = 10;
