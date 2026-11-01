import { beforeEach, describe, expect, it } from "vitest";
import { q, resetDbForTests } from "../queries/connection";
import type { Scope } from "@contracts/workspace/model";
import { getWorkspace } from "./service";
import { setFlowConsent, loadFlowEvents } from "./flowStore";
import { recordWorkspaceCommitted, recordWorkspaceDiscovery, recordWorkspacePresented } from "./flowAttribution";
import { loadApplyState } from "./store";

const scope: Scope = { surfaceId: "dashboard", deviceClass: "desktop" };

describe("server-side layout evidence", () => {
  beforeEach(async () => {
    await resetDbForTests();
    await q("INSERT INTO users(display_name,created_at) VALUES (?,?)", "First", Date.now());
  });

  it("requires opt-in and records a committed revision only as diagnostics on the old presentation", async () => {
    const current = await getWorkspace(1, scope, "tab-a");
    await recordWorkspaceCommitted(1, scope, "tab-a", "revision-new");
    expect(await loadFlowEvents(1, scope, current.descriptor.effectiveRevision)).toEqual([]);
    await setFlowConsent(1, true);
    await recordWorkspaceCommitted(1, scope, "tab-a", "revision-new");
    await recordWorkspaceCommitted(1, scope, "tab-a", "revision-new");
    const events = await loadFlowEvents(1, scope, current.descriptor.effectiveRevision);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "layout.committed", descriptor: current.descriptor, observedCommittedRevision: "revision-new" });
  });

  it("keeps two commits seen from one presentation, and one tab's desktop and phone views, apart", async () => {
    await setFlowConsent(1, true);
    const desktop = await getWorkspace(1, scope, "tab-a");
    await recordWorkspaceCommitted(1, scope, "tab-a", "revision-one");
    await recordWorkspaceCommitted(1, scope, "tab-a", "revision-two");
    expect((await loadFlowEvents(1, scope, desktop.descriptor.effectiveRevision)).map(event => event.observedCommittedRevision).sort()).toEqual(["revision-one", "revision-two"]);
    const phone: Scope = { surfaceId: "dashboard", deviceClass: "mobile" };
    const mobile = await getWorkspace(1, phone, "tab-a");
    await recordWorkspacePresented(1, scope, (await loadApplyState(1, scope)).presentations["tab-a"]);
    await recordWorkspacePresented(1, phone, (await loadApplyState(1, phone)).presentations["tab-a"]);
    expect(await loadFlowEvents(1, phone, mobile.descriptor.effectiveRevision)).toHaveLength(1);
  });

  it("keeps presented and undo events separate and idempotent", async () => {
    await setFlowConsent(1, true);
    const current = await getWorkspace(1, scope, "tab-a");
    const presentation = (await loadApplyState(1, scope)).presentations["tab-a"];
    await recordWorkspacePresented(1, scope, presentation);
    await recordWorkspacePresented(1, scope, presentation);
    await recordWorkspacePresented(1, scope, presentation, true);
    const events = await loadFlowEvents(1, scope, current.descriptor.effectiveRevision);
    expect(events.map(event => event.kind)).toEqual(["layout.presented", "layout.undone"]);
    expect(events.every(event => event.descriptor.effectiveRevision === current.descriptor.effectiveRevision)).toBe(true);
  });

  it("records seen and placed discovery anchors once per presentation", async () => {
    await setFlowConsent(1, true);
    const current = await getWorkspace(1, scope, "tab-a");
    await recordWorkspaceDiscovery(1, scope, "tab-a", "seen", "dashboard.stats");
    await recordWorkspaceDiscovery(1, scope, "tab-a", "seen", "dashboard.stats");
    await recordWorkspaceDiscovery(1, scope, "tab-a", "placed", "dashboard.stats");
    await recordWorkspaceDiscovery(1, scope, "tab-a", "placed", "dashboard.stats");
    const events = await loadFlowEvents(1, scope, current.descriptor.effectiveRevision);
    expect(events.map(event => event.kind)).toEqual(["discovery.seen", "discovery.placed"]);
    expect(events.every(event => event.anchorId === "dashboard.stats" && event.semanticRevision === 1)).toBe(true);
  });
});
