// How a tracker is connected from Settings → Connections: Jira by its login,
// GitHub by signing in on github.com, every other one with a personal token
// (and its address when it can be self-hosted). Where its pages open (its
// web host) when it isn't its API's.
import type { ProviderType } from "@contracts/providers";

export type How = "jiraLogin" | "oauthDevice" | "token";

export type TokenForm = {
  /** The API's address when the service has one for everyone; null: the user types theirs (self-hosted) */
  apiBase: string | null;
  /** Self-hosted servers may be on the user's own network */
  selfHosted: boolean;
  /** Where the user makes the token (shown as a hint) */
  tokenPage?: (base: string) => string;
  /** Where its pages open, when not on its API's host */
  webHost?: string;
};

export const TOKEN_FORMS: Partial<Record<ProviderType, TokenForm>> = {
  gitlab: { apiBase: null, selfHosted: true, tokenPage: (b) => `${b}/-/user_settings/personal_access_tokens` },
  gitea: { apiBase: null, selfHosted: true, tokenPage: (b) => `${b}/user/settings/applications` },
  linear: { apiBase: "https://api.linear.app", selfHosted: false, tokenPage: () => "https://linear.app/settings/account/security", webHost: "linear.app" },
  youtrack: { apiBase: null, selfHosted: true, tokenPage: (b) => `${b}/users/me?tab=account-security` },
  azure: { apiBase: null, selfHosted: true, tokenPage: (b) => `${b}/_usersSettings/tokens` },
  shortcut: { apiBase: "https://api.app.shortcut.com", selfHosted: false, tokenPage: () => "https://app.shortcut.com/settings/account/api-tokens", webHost: "app.shortcut.com" },
  plane: { apiBase: null, selfHosted: true },
  openproject: { apiBase: null, selfHosted: true },
  redmine: { apiBase: null, selfHosted: true },
  trello: { apiBase: "https://api.trello.com", selfHosted: false, webHost: "trello.com" },
  asana: { apiBase: "https://app.asana.com/api/1.0", selfHosted: false, webHost: "app.asana.com" },
  clickup: { apiBase: "https://api.clickup.com/api/v2", selfHosted: false, webHost: "app.clickup.com" },
  monday: { apiBase: "https://api.monday.com/v2", selfHosted: false, webHost: "monday.com" },
  notion: { apiBase: "https://api.notion.com/v1", selfHosted: false, webHost: "www.notion.so" },
  wrike: { apiBase: "https://www.wrike.com/api/v4", selfHosted: false },
  basecamp: { apiBase: "https://3.basecampapi.com", selfHosted: false, webHost: "3.basecamp.com" },
  todoist: { apiBase: "https://api.todoist.com", selfHosted: false, webHost: "app.todoist.com" },
  planner: { apiBase: "https://graph.microsoft.com/v1.0", selfHosted: false, webHost: "planner.cloud.microsoft" },
  // Time sinks
  tempo: { apiBase: "https://api.tempo.io/4", selfHosted: false, webHost: "app.tempo.io" },
  harvest: { apiBase: "https://api.harvestapp.com/v2", selfHosted: false, tokenPage: () => "https://id.getharvest.com/developers", webHost: "harvestapp.com" },
  clockify: { apiBase: "https://api.clockify.me/api/v1", selfHosted: false, webHost: "app.clockify.me" },
  toggl: { apiBase: "https://api.track.toggl.com/api/v9", selfHosted: false, webHost: "track.toggl.com" },
  everhour: { apiBase: "https://api.everhour.com", selfHosted: false, webHost: "app.everhour.com" },
};

/** How each tracker type is connected (null: not from the app). */
export const howOf = (type: ProviderType): How | null => (type === "jira" ? "jiraLogin" : type === "github" ? "oauthDevice" : TOKEN_FORMS[type] ? "token" : null);

/** Where an issue's pages open in a browser: its API's host, but for services that answer on another one. */
export function webHostOf(type: string, baseUrl: string): string {
  if (type === "github") return "github.com";
  return TOKEN_FORMS[type as ProviderType]?.webHost ?? new URL(baseUrl).host;
}
