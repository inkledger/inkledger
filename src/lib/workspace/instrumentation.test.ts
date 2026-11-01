import { describe, expect, it } from "vitest";
import { workspaceMutationPath } from "./instrumentation";

describe("workspace mutation telemetry mapping", () => {
  it("maps only declared mutation paths", () => {
    expect(workspaceMutationPath("dashboard.quickLog.save")).toEqual(["worklogs.create"]);
    expect(workspaceMutationPath("dashboard.planned.save")).toEqual(["planned.create", "planned.update"]);
    expect(workspaceMutationPath("shell.timer.pause")).toEqual(["timers.pause"]);
    expect(workspaceMutationPath("dashboard.timer.resume")).toEqual(["timers.start"]);
    expect(workspaceMutationPath("mobile.timer.start")).toEqual(["timers.start"]);
    expect(workspaceMutationPath("shell.sync.start")).toEqual(["issues.sync"]);
  });

  it("does not map arbitrary or private controls", () => {
    expect(workspaceMutationPath("dashboard.quickLog.input")).toBeUndefined();
    expect(workspaceMutationPath("worklogs.delete")).toBeUndefined();
    expect(workspaceMutationPath("dashboard.timer.logStopped")).toBeUndefined();
  });
});
