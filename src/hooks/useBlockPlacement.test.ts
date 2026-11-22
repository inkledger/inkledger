import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { fakeTrpc, fakeWindow, type FakeQuery } from "@/lib/testing/fakeTrpc";

const queries: Record<string, FakeQuery> = {};
vi.mock("@/lib/trpc", () => ({ trpc: fakeTrpc(queries) }));
vi.stubGlobal("window", fakeWindow());

const { useBlockPlacement } = await import("./useBlockPlacement");
const state = () => {
  const Probe = () => {
    const { ready, error } = useBlockPlacement();
    return createElement("p", null, `${ready ? "ready" : "waiting"} ${error ? "error" : "ok"}`);
  };
  return renderToString(createElement(Probe));
};

describe("where new time goes", () => {
  it("is ready once the day's worklogs, the timers and the schedule are read", () => {
    Object.assign(queries, { "worklogs.list": { data: [] }, "timers.list": { data: [] }, "workSchedule.list": { data: [] }, "workSchedule.days": { data: {} } });
    expect(state()).toBe("<p>ready ok</p>");
  });

  // The defaults stood in for a failed read and time was placed on them, with no error and no retry.
  it("never on the default schedule standing in for a failed read: an error to retry instead", () => {
    Object.assign(queries, { "worklogs.list": { data: [] }, "timers.list": { data: [] }, "workSchedule.list": { error: new Error("offline") }, "workSchedule.days": { data: {} } });
    expect(state()).toBe("<p>waiting error</p>");
  });

  // A refetch that failed keeps what was read: placing waited on a Retry although the schedule was there.
  it("a failed refetch over a schedule already read still places on it", () => {
    Object.assign(queries, { "worklogs.list": { data: [] }, "timers.list": { data: [] }, "workSchedule.list": { data: [], error: new Error("offline") }, "workSchedule.days": { data: {} } });
    expect(state()).toBe("<p>ready ok</p>");
  });
});
