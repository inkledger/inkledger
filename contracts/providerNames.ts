// How the app names each service (shown next to links and actions on an
// issue: "Open in GitHub"). Presentation only: the provider contract never
// depends on it.
import type { ProviderType } from "./providers";

export const PROVIDER_NAMES: Record<ProviderType, string> = {
  jira: "Jira",
  github: "GitHub",
  gitlab: "GitLab",
  azure: "Azure DevOps",
  gitea: "Gitea",
  linear: "Linear",
  youtrack: "YouTrack",
  shortcut: "Shortcut",
  plane: "Plane",
  openproject: "OpenProject",
  redmine: "Redmine",
  trello: "Trello",
  asana: "Asana",
  clickup: "ClickUp",
  monday: "monday.com",
  notion: "Notion",
  wrike: "Wrike",
  basecamp: "Basecamp",
  todoist: "Todoist",
  planner: "Microsoft Planner",
  tempo: "Tempo",
  harvest: "Harvest",
  clockify: "Clockify",
  toggl: "Toggl Track",
  everhour: "Everhour",
};

/** A stored type's name, or the type itself for one the app doesn't know. */
export const providerName = (type: string): string => (PROVIDER_NAMES as Record<string, string>)[type] ?? type;
