import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import { workspaceMutationPath } from "./instrumentation";
import { ROUTE_CONTROLS } from "./searchEvents";

/** Controls counted another way than a marked element, and why. */
const UNMARKED: Record<string, string> = {
  "shell.search.select": "the palette reports the chosen result itself (emitWorkspaceSearch)",
  "shell.timer.start": "the sidebar timer block draws nothing without a timer, and resuming one counts as shell.timer.resume; starting goes through shell.quickStart.open",
  "dashboard.closeDay": "its button is drawn in the Summary panel (dashboard.summary), not in the header's quick actions the catalog anchors it on",
  "dashboard.period.pickDate": "its button is drawn beside the page title, not in the period block (dashboard.period) the catalog anchors it on",
};

describe("workspace mutation telemetry mapping", () => {
  it("maps only declared mutation paths", () => {
    expect(workspaceMutationPath("dashboard.quickLog.save")).toEqual(["worklogs.create"]);
    expect(workspaceMutationPath("dashboard.planned.save")).toEqual(["planned.create", "planned.update"]);
    expect(workspaceMutationPath("shell.timer.pause")).toEqual(["timers.pause"]);
    expect(workspaceMutationPath("dashboard.timer.resume")).toEqual(["timers.start"]);
    // The tab bar's Play opens the picker: no mutation of its own to wait for.
    expect(workspaceMutationPath("mobile.timer.start")).toBeUndefined();
    expect(workspaceMutationPath("shell.sync.start")).toEqual(["issues.sync"]);
    expect(workspaceMutationPath("dashboard.gapCutter.save")).toEqual(["worklogs.create", "worklogs.update"]);
  });

  it("does not map arbitrary or private controls", () => {
    expect(workspaceMutationPath("dashboard.quickLog.input")).toBeUndefined();
    expect(workspaceMutationPath("worklogs.delete")).toBeUndefined();
    expect(workspaceMutationPath("dashboard.timer.logStopped")).toBeUndefined();
  });
});

// Every control FlowMap may count must be marked where it is drawn, or its clicks are lost (the Dashboard's
// were, until 2 Nov: maps stayed empty however much it was used).
describe("catalog controls are marked in the UI", () => {
  const files = readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter(file => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map(file => readFileSync(join("src", file), "utf8"));
  const strings = (text: string) => [...text.matchAll(/"([a-zA-Z][\w.-]*)"/g)].map(match => match[1]);
  const marked = new Set<string>();
  for (const text of files) {
    for (const [, args] of text.matchAll(/(?<!use)flowControlProps\(([^)]*)\)/gi)) strings(args).forEach(id => marked.add(id));
    for (const [, args] of text.matchAll(/useFlowControlProps\(([^)]*)\)/g)) strings(args).forEach(local => ["dashboard", "shell"].forEach(prefix => marked.add(`${prefix}.${local}`)));
    for (const [, id] of text.matchAll(/data-workspace-control="([^"]+)"/g)) marked.add(id);
    // A component that spreads flowControlProps(controlId) itself (MobileTabBar's Tab).
    for (const [, id] of text.matchAll(/\bcontrolId="([^"]+)"/g)) marked.add(id);
  }
  // Routes the shell's navigation reports by path (routeControlId), and search results (collector).
  Object.values(ROUTE_CONTROLS).forEach(id => marked.add(id));

  it.each(CATALOG_V1.controls.filter(control => !control.sensitive && control.interactions.every(item => item.telemetry !== "disabled")).map(control => control.id))("%s", id => {
    expect(marked.has(id) || UNMARKED[id] !== undefined, `${id} is never marked with flowControlProps`).toBe(true);
  });
});
