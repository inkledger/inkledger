import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowEvent } from "@contracts/workspace/flowMap";
import { startFlowCollection, type FlowCollectionOptions } from "./collector";
import { flowClickOf } from "./flowClick";

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

function setup(send: FlowCollectionOptions["send"], early?: FlowCollectionOptions["early"]) {
  const document = Object.assign(new EventTargetMock(), { hidden: false, body: {}, querySelectorAll: () => [] });
  const window = new EventTargetMock();
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  vi.stubGlobal("Element", ElementMock);
  vi.stubGlobal("location", { pathname: "/" });
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("MutationObserver", class { observe() {} disconnect() {} });
  const stop = startFlowCollection({
    scope: { surfaceId: "dashboard", deviceClass: "desktop" },
    descriptor: { effectiveRevision: "eff-test", sourceActiveRevision: "default", workspaceFingerprint: "fp", productDefaultVersion: "product-1", catalogVersion: "1.0.0", resolverVersion: 1, constraintsFingerprint: "constraints", feedbackFingerprint: "feedback", discoveryFingerprint: "discovery", rendererBindingsFingerprint: "renderers" },
    clientInstanceId: "tab-a",
    presentationEpoch: 1,
    send,
    early,
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

  it("never makes a second event out of one through offline, a retry or a lost answer (integration #15)", async () => {
    vi.useFakeTimers();
    // The server keeps the first copy of an id and ignores the rest (saveFlowEvents: on conflict do nothing).
    const stored = new Map<string, FlowEvent>();
    const sends: FlowEvent[][] = [];
    const { document, stop } = setup(async events => {
      sends.push(events);
      if (sends.length === 1) throw new TypeError("Failed to fetch");
      for (const event of events) if (!stored.has(event.id)) stored.set(event.id, event);
      if (sends.length === 2) throw new TypeError("Failed to fetch");
    });
    for (let index = 0; index < 3; index++) click(document);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stored.size).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    click(document);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    const all = sends.flat();
    const ids = new Set(all.map(event => event.id));
    // Every copy sent again is the same event (same id, same place in the session), so it is stored once.
    for (const event of all) expect(event).toEqual(stored.get(event.id));
    expect(stored.size).toBe(ids.size);
    expect([...stored.values()].map(event => event.sequence).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect([...stored.values()].filter(event => event.kind === "control.activate")).toHaveLength(4);
    stop({ optedOut: true });
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

describe("clicks before the collection has started", () => {
  it("counts a click made while its code was still loading, with where it landed in the block", () => {
    let beaconBody: Blob | undefined;
    vi.stubGlobal("navigator", { sendBeacon: (_: string, body: Blob) => { beaconBody = body; return true; } });
    const early = [{ controlId: "dashboard.logTime", clientX: 75, clientY: 25, block: { left: 0, top: 0, width: 100, height: 100 }, modality: "pointer" as const, path: "/" }];
    const sent: FlowEvent[] = [];
    const { stop } = setup(async events => { sent.push(...events); }, early);
    stop();
    expect(beaconBody).toBeDefined();
    return beaconBody?.text().then(text => {
      const events = (JSON.parse(text) as { json: { events: FlowEvent[] } }).json.events;
      expect(events.filter(event => event.kind === "control.activate").map(event => [event.controlId, event.cell])).toEqual([["dashboard.logTime", { x: 6, y: 2 }]]);
    });
  });
});

describe("where a click lands", () => {
  it("is measured on the block, not on the button that carries the block's name too", () => {
    const block = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }) };
    const button = {
      getAttribute: (name: string) => (name === "data-workspace-control" ? "dashboard.logTime" : "dashboard.quickActions"),
      closest: () => button,
      parentElement: { closest: () => block },
      getBoundingClientRect: () => ({ left: 150, top: 0, width: 50, height: 20 }),
    };
    vi.stubGlobal("Element", Object);
    vi.stubGlobal("location", { pathname: "/" });
    const click = flowClickOf({ target: button, clientX: 160, clientY: 10, detail: 1, pointerType: "mouse" } as unknown as MouseEvent);
    expect(click?.block).toEqual({ left: 0, top: 0, width: 200, height: 100 });
    expect(click?.modality).toBe("pointer");
  });
});

