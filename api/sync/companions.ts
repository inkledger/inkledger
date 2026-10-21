// Sinks that stand in for one tracker connection (Tempo for a Jira): which
// one (from their options) and the tracker's own id of an entry they filed.
// A leaf: the time writes and the sinks both read it.
import type { TimeSinkType, TrackerType } from "@contracts/providers";
import type { RemoteWorklog } from "../providers/types";
import { jiraWorklogIdOf } from "../providers/tempo/adapter";

export const COMPANIONS: Partial<Record<TimeSinkType, { tracker: TrackerType; option: string; trackerIdOf: (r: RemoteWorklog) => string | null }>> = {
  tempo: { tracker: "jira", option: "jiraConnectionId", trackerIdOf: jiraWorklogIdOf },
};

/** The sink types that stand in for a tracker. */
export const COMPANION_TYPES = Object.keys(COMPANIONS) as TimeSinkType[];
