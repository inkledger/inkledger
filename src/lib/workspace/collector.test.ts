import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowEvent } from "@contracts/workspace/flowMap";
import { startFlowCollection, type FlowCollectionOptions } from "./collector";

class EventTargetMock {
  private listeners = new Map<string, Set<(event: never) => void>>();

  addEventListener(kind: string, listener: (event: never) => void) {
    const current = this.listeners.get(kind) ?? new Set();
    current.add(listener);
    this.listeners.set(kind, current);
  }

  removeEventListener(kind: string, listener: (event: never) => void) {
    this.listeners.get(kind)?.delete(listener);
  }

  emit(kind: string, event: unknown = {}) {
    for (const listener of this.listeners.get(kind) ?? []) listener(event as never);
  }
}

class ElementMock {
  private readonly control: string;
  private readonly anchor: string;

  constructor(control = "dashboard.logTime", anchor = "dashboard.quickActions") {
    this.control = control;
    this.anchor = anchor;
  }

  getAttribute(name: string) {
    return name === "data-workspace-control" ? this.control : this.anchor;
  }

  closest() {
    return this;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 };
  }
}

function setup(send: FlowCollectionOptions["send"]) {
  const document = Object.assign(new EventTargetMock(), { hidden: false, body: {}, querySelectorAll: () => [] });
  const window = new EventTargetMock();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("Element", ElementMock);
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  const stop = startFlowCollection({
    scope: { surfaceId: "dashboard", deviceClass: "desktop" },
    descriptor: { effectiveRevision: "eff-test", sourceActiveRevision: "default", workspaceFingerprint: "fp", productDefaultVersion: "product-1", catalogVersion: "1.0.0", resolverVersion: 1, constraintsFingerprint: "constraints", feedbackFingerprint: "feedback", discoveryFingerprint: "discovery", rendererBindingsFingerprint: "renderers" },
    clientInstanceId: "tab-a",
    presentationEpoch: 1,
    send,
  });
  return { document, window, stop };
}

function click(document: EventTargetMock) {
  document.emit("click", { target: new ElementMock(), detail: 1, clientX: 10, clientY: 10 });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("FlowMap collection delivery", () => {
  it("keeps batches bounded when events arrive during a slow send", async () => {
    const sends: FlowEvent[][] = [];
    let release!: () => void;
    const { document, stop } = setup(events => {
      sends.push(events);
      return sends.length === 1 ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
    });
    for (let index = 0; index < 50; index++) click(document);
    expect(sends).toHaveLength(1);
    vi.useFakeTimers();
    for (let index = 0; index < 60; index++) click(document);
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sends.length).toBeGreaterThan(1);
    expect(sends.every(batch => batch.length <= 50 && JSON.stringify(batch).length <= 32_000)).toBe(true);
    expect(sends.flat()).toHaveLength(111);
    stop();
  });

  it("uses the RPC transformer envelope for page-hide beacons", async () => {
    let beaconBody: Blob | undefined;
    const sendBeacon = vi.fn((_url: string, body: Blob) => { beaconBody = body; return true; });
    vi.stubGlobal("navigator", { sendBeacon });
    const { document, window, stop } = setup(async () => {});
    click(document);
    window.emit("pagehide");
    expect(sendBeacon).toHaveBeenCalledOnce();
    const body = JSON.parse(await beaconBody!.text()) as { json?: { events?: FlowEvent[] } };
    expect(body.json?.events?.some(event => event.kind === "control.activate")).toBe(true);
    stop();
  });

  it("sends what is still queued when the collection stops (navigation, apply, scope change)", () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon });
    const { document, stop } = setup(async () => {});
    for (let index = 0; index < 3; index++) click(document);
    stop();
    expect(sendBeacon).toHaveBeenCalledOnce();
  });

  it("sends nothing at all when the collection stops because the user opted out", () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon });
    const { document, stop } = setup(async () => {});
    for (let index = 0; index < 3; index++) click(document);
    stop({ optedOut: true });
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("records an action's outcome even when another mutation finishes first", () => {
    const sends: FlowEvent[][] = [];
    vi.stubGlobal("navigator", { sendBeacon: vi.fn((_url: string, body: Blob) => { void body.text().then(text => sends.push((JSON.parse(text) as { json: { events: FlowEvent[] } }).json.events)); return true; }) });
    const { document, window, stop } = setup(async () => {});
    document.emit("click", { target: new ElementMock("dashboard.timer.pause", "dashboard.headerTimer"), detail: 1, clientX: 10, clientY: 10 });
    window.emit("workspace:mutation-result", { detail: { path: "flowMap.ingest", succeeded: true } });
    window.emit("workspace:mutation-result", { detail: { path: "timers.pause", succeeded: true } });
    window.emit("pagehide");
    stop();
    return new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => {
      expect(sends.flat().filter(event => event.kind === "action.succeeded")).toHaveLength(1);
    });
  });
});

