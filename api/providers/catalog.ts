// What every catalogued service can do and has, written in the contract's
// own schemas (CATALOG.md has the sources; its matrix is generated from
// here). Most are not built: these entries hold the contract to the whole
// catalogue (each one parses), and an adapter, when built, starts from its
// entry and must keep to it (registry test). Values on a plan or version
// still to verify are marked (verify: <id>), each id a row of the spikes
// table in docs/dev/spikes.md (catalogMatrix.test.ts holds the two together).
// A marked value is always the conservative one; the spike may promote it.
import type { TimeSinkCapabilities, TimeSinkTraits, TimeSinkType, TrackerCapabilities, TrackerTraits, TrackerType } from "@contracts/providers";
import { jiraCapabilities, jiraTraits } from "./jira/adapter";
import { githubCapabilities, githubTraits } from "./github/adapter";
import { tempoSinkCapabilities, tempoSinkTraits } from "./tempo/adapter";
import { togglSinkCapabilities, togglSinkTraits } from "./toggl/adapter";
import { harvestSinkCapabilities, harvestSinkTraits } from "./harvest/adapter";
import { clockifySinkCapabilities, clockifySinkTraits } from "./clockify/adapter";
import { everhourSinkCapabilities, everhourSinkTraits } from "./everhour/adapter";
import { clickupCapabilities, clickupTraits } from "./clickup/adapter";
import { mondayCapabilities, mondayTraits } from "./monday/adapter";
import { notionCapabilities, notionTraits } from "./notion/adapter";
import { basecampCapabilities, basecampTraits } from "./basecamp/adapter";
import { wrikeCapabilities, wrikeTraits } from "./wrike/adapter";
import { plannerCapabilities, plannerTraits } from "./planner/adapter";
import { todoistCapabilities, todoistTraits } from "./todoist/adapter";
import { asanaCapabilities, asanaTraits } from "./asana/adapter";
import { openprojectCapabilities, openprojectTraits } from "./openproject/adapter";
import { redmineCapabilities, redmineTraits } from "./redmine/adapter";
import { planeCapabilities, planeTraits } from "./plane/adapter";
import { trelloCapabilities, trelloTraits } from "./trello/adapter";
import { shortcutCapabilities, shortcutTraits } from "./shortcut/adapter";
import { azureCapabilities, azureTraits } from "./azure/adapter";
import { giteaCapabilities, giteaTraits } from "./gitea/adapter";
import { gitlabCapabilities, gitlabTraits } from "./gitlab/adapter";
import { linearCapabilities, linearTraits } from "./linear/adapter";
import { youtrackCapabilities, youtrackTraits } from "./youtrack/adapter";


export const TRACKERS: Record<TrackerType, { capabilities: TrackerCapabilities; traits: TrackerTraits }> = {
  jira: { capabilities: jiraCapabilities, traits: jiraTraits },
  // Built: the adapter's own declaration (Projects v2 status after github-projects; transfers after github-transfer).
  github: { capabilities: githubCapabilities, traits: githubTraits },
  // Built (experimental, on a simulator): the adapter's own declaration (gitlab-statuses, gitlab-timelog still to run).
  gitlab: { capabilities: gitlabCapabilities, traits: gitlabTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  azure: { capabilities: azureCapabilities, traits: azureTraits },
  // Built (experimental): the adapter's own declaration, on a simulator until its spikes run (docs/dev/spikes.md).
  gitea: { capabilities: giteaCapabilities, traits: giteaTraits },
  // Built (experimental, on a simulator): the adapter's own declaration (webhook payloads and departures after the Linear spikes).
  linear: { capabilities: linearCapabilities, traits: linearTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  youtrack: { capabilities: youtrackCapabilities, traits: youtrackTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  shortcut: { capabilities: shortcutCapabilities, traits: shortcutTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  plane: { capabilities: planeCapabilities, traits: planeTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  openproject: { capabilities: openprojectCapabilities, traits: openprojectTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  redmine: { capabilities: redmineCapabilities, traits: redmineTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  trello: { capabilities: trelloCapabilities, traits: trelloTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  asana: { capabilities: asanaCapabilities, traits: asanaTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  clickup: { capabilities: clickupCapabilities, traits: clickupTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  monday: { capabilities: mondayCapabilities, traits: mondayTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  notion: { capabilities: notionCapabilities, traits: notionTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  wrike: { capabilities: wrikeCapabilities, traits: wrikeTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  basecamp: { capabilities: basecampCapabilities, traits: basecampTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  todoist: { capabilities: todoistCapabilities, traits: todoistTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  planner: { capabilities: plannerCapabilities, traits: plannerTraits },
};

export const SINKS: Record<TimeSinkType, { capabilities: TimeSinkCapabilities; traits: TimeSinkTraits }> = {
  // Built (experimental, on a simulator): the adapter's own declaration.
  tempo: { capabilities: tempoSinkCapabilities, traits: tempoSinkTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  harvest: { capabilities: harvestSinkCapabilities, traits: harvestSinkTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  clockify: { capabilities: clockifySinkCapabilities, traits: clockifySinkTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  toggl: { capabilities: togglSinkCapabilities, traits: togglSinkTraits },
  // Built (experimental, on a simulator): the adapter's own declaration.
  everhour: { capabilities: everhourSinkCapabilities, traits: everhourSinkTraits },
};
