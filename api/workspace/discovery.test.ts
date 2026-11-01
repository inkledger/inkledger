import { beforeEach, describe, expect, it } from "vitest";
import { q, resetDbForTests } from "../queries/connection";
import { getDiscoveryState, saveDiscoveryState } from "./discovery";

const scope = { surfaceId: "dashboard", deviceClass: "desktop" } as const;

describe("workspace discovery state", () => {
  beforeEach(async () => {
    await resetDbForTests();
  });

  it("persists seen, placed and dismissed anchors per user and scope", async () => {
    const [first] = await q<{ id: number }>("INSERT INTO users(display_name, created_at) VALUES (?, ?) RETURNING id", "First", 1_800_000_000_000);
    const [second] = await q<{ id: number }>("INSERT INTO users(display_name, created_at) VALUES (?, ?) RETURNING id", "Second", 1_800_000_000_000);
    expect(await getDiscoveryState(first.id, scope)).toEqual({ seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [], seenAreaIds: [], placedAreaIds: [], dismissedAreaIds: [] });
    await saveDiscoveryState(first.id, scope, { seenAnchorIds: ["b", "a", "b"], placedAnchorIds: ["a"], dismissedAnchorIds: ["b"] });
    expect(await getDiscoveryState(first.id, scope)).toEqual({ seenAnchorIds: ["a", "b"], placedAnchorIds: ["a"], dismissedAnchorIds: ["b"], seenAreaIds: [], placedAreaIds: [], dismissedAreaIds: [] });
    expect(await getDiscoveryState(second.id, scope)).toEqual({ seenAnchorIds: [], placedAnchorIds: [], dismissedAnchorIds: [], seenAreaIds: [], placedAreaIds: [], dismissedAreaIds: [] });
    await saveDiscoveryState(first.id, scope, { seenAnchorIds: ["a"], placedAnchorIds: ["a"], dismissedAnchorIds: [] });
    expect(await getDiscoveryState(first.id, scope)).toEqual({ seenAnchorIds: ["a"], placedAnchorIds: ["a"], dismissedAnchorIds: [], seenAreaIds: [], placedAreaIds: [], dismissedAreaIds: [] });
  });
});
