// A Jira login as the forms hold it (activating an account, connecting Jira).
export type JiraLogin = {
  deployment: "cloud" | "server";
  authType: "basic" | "bearer";
  siteUrl: string;
  username: string;
  secret: string;
};

export const emptyJiraLogin = (): JiraLogin => ({ deployment: "server", authType: "basic", siteUrl: "", username: "", secret: "" });

/** What the server takes: Cloud always signs in with basic auth. */
export const jiraLoginPayload = (v: JiraLogin) => ({ ...v, authType: v.deployment === "cloud" ? ("basic" as const) : v.authType });
