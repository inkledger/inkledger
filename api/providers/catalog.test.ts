import { describe, expect, it } from "vitest";
import { TIME_SINK_TYPES, TRACKER_TYPES, timeSinkCapabilitiesSchema, timeSinkTraitsSchema, trackerCapabilitiesSchema, trackerTraitsSchema } from "@contracts/providers";
import { SINKS, TRACKERS } from "./catalog";
import { SINK_REGISTRY, TRACKER_REGISTRY, availableTrackers, registryProblems } from "./registry";

describe("the provider catalogue and registry", () => {
  it("describe every known service, in the contract's schemas", () => {
    expect(Object.keys(TRACKERS).sort()).toEqual([...TRACKER_TYPES].sort());
    expect(Object.keys(SINKS).sort()).toEqual([...TIME_SINK_TYPES].sort());
    for (const [type, e] of Object.entries(TRACKERS)) {
      const c = trackerCapabilitiesSchema.safeParse(e.capabilities);
      expect(c.success, `${type}: ${JSON.stringify(c.error?.issues)}`).toBe(true);
      expect(trackerTraitsSchema.safeParse(e.traits).success, type).toBe(true);
    }
    for (const [type, e] of Object.entries(SINKS)) {
      const c = timeSinkCapabilitiesSchema.safeParse(e.capabilities);
      expect(c.success, `${type}: ${JSON.stringify(c.error?.issues)}`).toBe(true);
      expect(timeSinkTraitsSchema.safeParse(e.traits).success, type).toBe(true);
    }
  });

  it("registers every type, and built adapters keep to the contract and their catalogue entry", () => {
    expect(Object.keys(TRACKER_REGISTRY).sort()).toEqual([...TRACKER_TYPES].sort());
    expect(Object.keys(SINK_REGISTRY).sort()).toEqual([...TIME_SINK_TYPES].sort());
    expect(registryProblems()).toEqual([]);
    expect(availableTrackers()).toEqual(["jira", "github", "gitlab", "azure", "gitea", "linear", "youtrack", "shortcut", "plane", "openproject", "redmine", "trello", "asana", "clickup", "monday", "notion", "wrike", "basecamp", "todoist", "planner"]);
  });
});
