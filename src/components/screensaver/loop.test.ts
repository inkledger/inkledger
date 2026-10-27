import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canvasScale, runLoop } from "./loop";

describe("runLoop", () => {
  let hidden: boolean;
  let callbacks: Map<number, FrameRequestCallback>;
  let nextId: number;
  let visibilityListeners: Set<() => void>;

  const flush = (now: number) => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach(callback => callback(now));
  };

  beforeEach(() => {
    hidden = false;
    callbacks = new Map();
    nextId = 1;
    visibilityListeners = new Set();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    vi.stubGlobal("document", {
      get hidden() { return hidden; },
      addEventListener: (type: string, listener: () => void) => {
        if (type === "visibilitychange") visibilityListeners.add(listener);
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === "visibilitychange") visibilityListeners.delete(listener);
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("limits frames to the requested rate", () => {
    const frame = vi.fn();
    runLoop(30, frame);
    flush(100);
    flush(110);
    expect(frame).toHaveBeenCalledTimes(1);
    flush(140);
    expect(frame).toHaveBeenCalledTimes(2);
    expect(frame).toHaveBeenLastCalledWith(0.04, 140);
  });

  it("caps elapsed time after a long frame", () => {
    const frame = vi.fn();
    runLoop(30, frame);
    flush(100);
    flush(1_000);
    expect(frame).toHaveBeenLastCalledWith(0.1, 1_000);
  });

  it("pauses while hidden and resumes with a fresh clock", () => {
    const frame = vi.fn();
    runLoop(30, frame);
    flush(100);
    hidden = true;
    visibilityListeners.forEach(listener => listener());
    flush(200);
    expect(frame).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0);
    hidden = false;
    visibilityListeners.forEach(listener => listener());
    flush(1_000);
    expect(frame).toHaveBeenCalledTimes(2);
    expect(frame.mock.lastCall?.[0]).toBeCloseTo(1 / 30);
    expect(frame).toHaveBeenLastCalledWith(expect.any(Number), 1_000);
  });

  it("cancels scheduling and removes the visibility listener on stop", () => {
    const frame = vi.fn();
    const stop = runLoop(30, frame);
    stop();
    flush(100);
    expect(frame).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0);
    expect(visibilityListeners.size).toBe(0);
  });
});

describe("canvasScale", () => {
  it("caps device pixel ratio at 1.5", () => {
    expect(canvasScale(1280, 720, 3)).toBe(1.5);
    expect(canvasScale(1280, 720, 1)).toBe(1);
  });

  it("limits large canvases to the pixel budget", () => {
    const scale = canvasScale(2560, 1440, 2);
    expect(scale).toBeCloseTo(Math.sqrt(3_500_000 / (2560 * 1440)));
    expect(2560 * 1440 * scale * scale).toBeCloseTo(3_500_000);
  });

  it("keeps a minimum scale on extremely large canvases", () => {
    expect(canvasScale(10_000, 10_000, 2)).toBe(0.5);
  });
});
