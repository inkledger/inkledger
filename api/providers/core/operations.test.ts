import { describe, expectTypeOf, it } from "vitest";
import type {
  SinkGroupMembersCovered,
  SinkGroupsCovered,
  SinkMethodsCovered,
  TrackerGroupMembersCovered,
  TrackerGroupsCovered,
  TrackerMethodsCovered,
} from "./operations";
import type { ProviderShape, TimeSinkShape, TrackerShape } from "../types";
import type { jiraProvider } from "../jira/adapter";

describe("operation names (compile-time)", () => {
  it("name every operation of the provider interfaces, and nothing else", () => {
    expectTypeOf<TrackerMethodsCovered>().toEqualTypeOf<true>();
    expectTypeOf<TrackerGroupsCovered>().toEqualTypeOf<true>();
    expectTypeOf<TrackerGroupMembersCovered>().toEqualTypeOf<Readonly<{ transitions: true; worklogs: true; timeCounter: true; comments: true; manage: true }>>();
    expectTypeOf<SinkMethodsCovered>().toEqualTypeOf<true>();
    expectTypeOf<SinkGroupsCovered>().toEqualTypeOf<true>();
    expectTypeOf<SinkGroupMembersCovered>().toEqualTypeOf<true>();
  });

  it("built adapters fit the shapes the validator checks", () => {
    expectTypeOf<typeof jiraProvider>().toExtend<TrackerShape>();
    expectTypeOf<TrackerShape>().toExtend<ProviderShape>();
    expectTypeOf<TimeSinkShape>().toExtend<ProviderShape>();
  });
});
