// Every provider type with its build status and, when built, its adapter:
// exhaustive over the catalogue (a type without an entry fails to compile),
// and checked at load: a built adapter that breaks the contract or drifts
// from its catalogue entry never runs.
import type { BuildStatus, TimeSinkType, TrackerType } from "@contracts/providers";
import { assertProvider } from "./core/validate";
import { jiraProvider, type JiraOptions } from "./jira/adapter";
import { githubProvider, type GitHubOptions } from "./github/adapter";
import { tempoSink } from "./tempo/adapter";
import { togglSink } from "./toggl/adapter";
import { harvestSink } from "./harvest/adapter";
import { clockifySink } from "./clockify/adapter";
import { everhourSink } from "./everhour/adapter";
import { clickupProvider, type ClickUpOptions } from "./clickup/adapter";
import { mondayProvider, type MondayOptions } from "./monday/adapter";
import { notionProvider, type NotionOptions } from "./notion/adapter";
import { basecampProvider, type BasecampOptions } from "./basecamp/adapter";
import { wrikeProvider, type WrikeOptions } from "./wrike/adapter";
import { plannerProvider, type PlannerOptions } from "./planner/adapter";
import { todoistProvider, type TodoistOptions } from "./todoist/adapter";
import { asanaProvider, type AsanaOptions } from "./asana/adapter";
import { openprojectProvider, type OpenProjectOptions } from "./openproject/adapter";
import { redmineProvider, type RedmineOptions } from "./redmine/adapter";
import { planeProvider, type PlaneOptions } from "./plane/adapter";
import { trelloProvider, type TrelloOptions } from "./trello/adapter";
import { shortcutProvider, type ShortcutOptions } from "./shortcut/adapter";
import { azureProvider, type AzureOptions } from "./azure/adapter";
import { giteaProvider, type GiteaOptions } from "./gitea/adapter";
import { gitlabProvider, type GitLabOptions } from "./gitlab/adapter";
import { linearProvider, type LinearOptions } from "./linear/adapter";
import { youtrackProvider, type YouTrackOptions } from "./youtrack/adapter";
import { SINKS, TRACKERS } from "./catalog";
import type { TimeSinkProvider, TrackerProvider } from "./types";

/** Planned: no adapter yet. Built, experimental or disabled: an adapter (a disabled one kept, not offered). */
/** A built tracker adapter, its type telling its options. */
export type AnyTracker =
  | TrackerProvider<"jira", JiraOptions>
  | TrackerProvider<"github", GitHubOptions>
  | TrackerProvider<"clickup", ClickUpOptions>
  | TrackerProvider<"monday", MondayOptions>
  | TrackerProvider<"notion", NotionOptions>
  | TrackerProvider<"basecamp", BasecampOptions>
  | TrackerProvider<"wrike", WrikeOptions>
  | TrackerProvider<"planner", PlannerOptions>
  | TrackerProvider<"todoist", TodoistOptions>
  | TrackerProvider<"asana", AsanaOptions>
  | TrackerProvider<"openproject", OpenProjectOptions>
  | TrackerProvider<"redmine", RedmineOptions>
  | TrackerProvider<"plane", PlaneOptions>
  | TrackerProvider<"trello", TrelloOptions>
  | TrackerProvider<"shortcut", ShortcutOptions>
  | TrackerProvider<"azure", AzureOptions>
  | TrackerProvider<"gitea", GiteaOptions>
  | TrackerProvider<"gitlab", GitLabOptions>
  | TrackerProvider<"linear", LinearOptions>
  | TrackerProvider<"youtrack", YouTrackOptions>;

type TrackerEntry = { status: Extract<BuildStatus, "planned"> } | { status: Exclude<BuildStatus, "planned">; adapter: AnyTracker };
type SinkEntry = { status: Extract<BuildStatus, "planned"> } | { status: Exclude<BuildStatus, "planned">; adapter: TimeSinkProvider };

export const TRACKER_REGISTRY = {
  jira: { status: "built", adapter: jiraProvider },
  github: { status: "built", adapter: githubProvider },
  gitlab: { status: "built", adapter: gitlabProvider },
  azure: { status: "experimental", adapter: azureProvider },
  gitea: { status: "experimental", adapter: giteaProvider },
  linear: { status: "experimental", adapter: linearProvider },
  youtrack: { status: "experimental", adapter: youtrackProvider },
  shortcut: { status: "experimental", adapter: shortcutProvider },
  plane: { status: "experimental", adapter: planeProvider },
  openproject: { status: "experimental", adapter: openprojectProvider },
  redmine: { status: "experimental", adapter: redmineProvider },
  trello: { status: "experimental", adapter: trelloProvider },
  asana: { status: "experimental", adapter: asanaProvider },
  clickup: { status: "experimental", adapter: clickupProvider },
  monday: { status: "experimental", adapter: mondayProvider },
  notion: { status: "experimental", adapter: notionProvider },
  wrike: { status: "experimental", adapter: wrikeProvider },
  basecamp: { status: "experimental", adapter: basecampProvider },
  todoist: { status: "experimental", adapter: todoistProvider },
  planner: { status: "experimental", adapter: plannerProvider },
} satisfies Record<TrackerType, TrackerEntry>;

export const SINK_REGISTRY = {
  tempo: { status: "experimental", adapter: tempoSink },
  harvest: { status: "experimental", adapter: harvestSink },
  clockify: { status: "experimental", adapter: clockifySink },
  toggl: { status: "experimental", adapter: togglSink },
  everhour: { status: "experimental", adapter: everhourSink },
} satisfies Record<TimeSinkType, SinkEntry>;

/** A built time sink adapter, or null. */
export function sinkAdapter(type: TimeSinkType): TimeSinkProvider | null {
  // A connection's type read from the database may be a tracker's: no sink.
  const entry = (SINK_REGISTRY as Partial<Record<string, SinkEntry>>)[type];
  return entry && "adapter" in entry && entry.status !== "disabled" ? entry.adapter : null;
}

/** A time sink type's build status. */
export const sinkStatus = (type: TimeSinkType): BuildStatus => (SINK_REGISTRY as Record<TimeSinkType, SinkEntry>)[type].status;

/** A tracker type's build status ("experimental": built on a simulator, not verified on a real account). */
export const trackerStatus = (type: TrackerType): BuildStatus => (TRACKER_REGISTRY as Record<TrackerType, TrackerEntry>)[type].status;

/** Every problem of the registry: adapters against the contract and against their catalogue entry. */
export function registryProblems(): string[] {
  const out: string[] = [];
  for (const [type, entry] of Object.entries(TRACKER_REGISTRY) as [TrackerType, TrackerEntry][]) {
    if (!("adapter" in entry)) continue;
    try {
      assertProvider(entry.adapter);
    } catch (e) {
      out.push(e instanceof Error ? e.message : String(e));
    }
    if (entry.adapter.type !== type) out.push(`${type}: adapter of type ${entry.adapter.type}`);
    if (JSON.stringify(entry.adapter.capabilities) !== JSON.stringify(TRACKERS[type].capabilities)) out.push(`${type}: capabilities differ from the catalogue`);
    if (JSON.stringify(entry.adapter.traits) !== JSON.stringify(TRACKERS[type].traits)) out.push(`${type}: traits differ from the catalogue`);
  }
  for (const [type, entry] of Object.entries(SINK_REGISTRY) as [TimeSinkType, SinkEntry][]) {
    if (!("adapter" in entry)) continue;
    try {
      assertProvider(entry.adapter);
    } catch (e) {
      out.push(e instanceof Error ? e.message : String(e));
    }
    if (JSON.stringify(entry.adapter.capabilities) !== JSON.stringify(SINKS[type].capabilities)) out.push(`${type}: capabilities differ from the catalogue`);
  }
  return out;
}

// Checked once, when the server loads the layer: never run a broken adapter.
const problems = registryProblems();
if (problems.length > 0) throw new Error(`Provider registry:\n- ${problems.join("\n- ")}`);

/** The tracker adapter for a type, when built. */
export function trackerAdapter(type: TrackerType): AnyTracker | null {
  // A connection's type read from the database may be a sink's: no tracker.
  const entry = (TRACKER_REGISTRY as Partial<Record<string, TrackerEntry>>)[type];
  return entry && "adapter" in entry && entry.status !== "disabled" ? entry.adapter : null;
}

/** The provider types a connection can be made with today. */
export const availableTrackers = (): TrackerType[] => (Object.keys(TRACKER_REGISTRY) as TrackerType[]).filter((t) => trackerAdapter(t) !== null);
