import { describe, expect, it, vi } from "vitest";
import { createGestures, GESTURE_MS, GIVE_BACK_MS, ownReports, PICTURE_GESTURE_MS, watchGiveBack } from "./gesture";

function setup() {
  let t = 10_000;
  let active = true;
  const g = createGestures({ now: () => t, active: () => active });
  const frame = { name: "the module's view frame" };
  const box = { name: "its host box" };
  const other = { name: "another module's frame" };
  return { g, frame, box, other, tick: (ms: number) => (t += ms), setActive: (on: boolean) => (active = on) };
}

describe("whose gesture it was", () => {
  it("never a click anywhere on the app", () => {
    const { g, frame, box } = setup();
    g.app();
    expect(g.has(frame, box, false)).toBe(false);
  });

  it("a click on the module's own host box, for a while, until the person acts elsewhere", () => {
    const { g, frame, box, tick } = setup();
    g.app();
    g.box(box);
    expect(g.has(frame, box, false)).toBe(true);
    tick(GESTURE_MS + 1);
    expect(g.has(frame, box, false)).toBe(false);
    g.box(box);
    tick(10);
    g.app();
    expect(g.has(frame, box, false)).toBe(false);
    // Another module's box is an act elsewhere too.
    g.box(box);
    tick(10);
    g.box({});
    expect(g.has(frame, box, false)).toBe(false);
  });

  it("a pointer down in the module's own frame, as its bootstrap saw it; another frame's is not this one's", () => {
    const { g, frame, box, other, tick } = setup();
    g.app();
    tick(10);
    g.own(other, "pointer");
    expect(g.has(frame, box, false)).toBe(false);
    g.own(frame, "pointer");
    expect(g.has(frame, box, false)).toBe(true);
    tick(10);
    g.app();
    expect(g.has(frame, box, false)).toBe(false);
  });

  it("a frame's window taking the focus: kept on Tab, a pointer there or the host's own focus; else not the person's", () => {
    const { g, frame, other, tick } = setup();
    g.app();
    tick(10);
    // By itself: the host gives the focus back.
    expect(g.tookFocus(frame)).toBe(false);
    g.tab();
    expect(g.tookFocus(frame)).toBe(true);
    tick(2000);
    expect(g.tookFocus(frame)).toBe(false);
    g.own(frame, "pointer");
    expect(g.tookFocus(frame)).toBe(true);
    // Another frame's pointer is no reason for this one.
    tick(2000);
    g.own(other, "pointer");
    expect(g.tookFocus(frame)).toBe(false);
    g.hostFocus(frame);
    expect(g.tookFocus(frame)).toBe(true);
    // A key in another frame the person is in (Tab out of it) moves the focus on.
    tick(2000);
    const third = { name: "a third frame" };
    g.own(third, "tab");
    expect(g.tookFocus(frame)).toBe(false);
    g.own(third, "pointer");
    tick(2000);
    // Typing there is not leaving it.
    g.own(third, "key");
    expect(g.tookFocus(frame)).toBe(false);
    g.own(third, "tab");
    expect(g.tookFocus(frame)).toBe(true);
    // Keys typed into a frame that grabbed the focus are no reason for it to keep it.
    tick(2000);
    g.app();
    expect(g.tookFocus(frame)).toBe(false);
    g.own(frame, "tab");
    expect(g.tookFocus(frame)).toBe(false);
    // Refused: its keys are not the person's either.
    tick(2000);
    g.app();
    expect(g.tookFocus(frame)).toBe(false);
  });

  it("a frame that takes the focus by itself gets nothing from the keys typed into it", () => {
    const { g, frame, box, tick } = setup();
    g.app();
    tick(10);
    g.focusIn(frame);
    g.own(frame, "key");
    expect(g.has(frame, box, true)).toBe(false);
  });

  it("the keyboard: a key in a frame the person moved into by Tab, while it keeps the focus", () => {
    const { g, frame, box, tick } = setup();
    g.app();
    g.tab();
    tick(5);
    g.focusIn(frame);
    tick(2000);
    g.own(frame, "key");
    expect(g.has(frame, box, true)).toBe(true);
    expect(g.has(frame, box, false)).toBe(false);
  });

  it("keys in a frame the person clicked into: type in a field, then Enter", () => {
    const { g, frame, box, tick } = setup();
    g.app();
    tick(10);
    g.own(frame, "pointer");
    g.focusIn(frame);
    tick(3000);
    g.own(frame, "key");
    expect(g.has(frame, box, true)).toBe(true);
  });

  it("keys in a frame the host focused (a sheet opening from the keyboard)", () => {
    const { g, frame, box, tick } = setup();
    g.box(box);
    tick(10);
    g.focusIn(frame);
    g.hostFocus(frame);
    tick(2000);
    g.own(frame, "key");
    expect(g.has(frame, box, true)).toBe(true);
  });

  it("as long as the browser's own activation, a picture the module draws first at least as long", () => {
    const { g, frame, box, tick } = setup();
    expect(PICTURE_GESTURE_MS).toBeGreaterThanOrEqual(GESTURE_MS);
    g.own(frame, "pointer");
    tick(GESTURE_MS - 1);
    expect(g.has(frame, box, false)).toBe(true);
    expect(g.has(frame, box, false, PICTURE_GESTURE_MS)).toBe(true);
    tick(Math.max(GESTURE_MS, PICTURE_GESTURE_MS) + 1);
    expect(g.has(frame, box, false)).toBe(false);
    expect(g.has(frame, box, false, PICTURE_GESTURE_MS)).toBe(false);
  });

  it("only while the browser still counts the person's activation", () => {
    const { g, frame, box, setActive } = setup();
    g.box(box);
    g.own(frame, "pointer");
    setActive(false);
    expect(g.has(frame, box, true)).toBe(false);
  });
});

describe("a view's own reports", () => {
  it("a call is held until the reports it follows are in, and a made-up count only for a moment", async () => {
    const kinds: string[] = [];
    const own = ownReports(k => kinds.push(k));
    expect(own.settle(0)).toBeNull();
    const held = own.settle(1);
    expect(held).not.toBeNull();
    own.port.postMessage("pointer");
    await held;
    expect(kinds).toEqual(["pointer"]);
    expect(own.settle(1)).toBeNull();
    vi.useFakeTimers();
    try {
      let done = false;
      void own.settle(99)?.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(GESTURE_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
      own.close();
    }
  });
});

describe("a refused grab, given back", () => {
  function watch(at: { holds: boolean; placed?: boolean; current?: boolean }) {
    let t = 0;
    const looks: (() => void)[] = [];
    const given: number[] = [];
    watchGiveBack({
      now: () => t,
      next: fn => looks.push(fn),
      holds: () => at.holds,
      placed: () => at.placed === true,
      current: () => at.current !== false,
      giveBack: () => {
        given.push(t);
        at.holds = false;
      },
    });
    /** The browser's next frame, `ms` later. */
    const frame = (ms = 16) => {
      t += ms;
      looks.shift()?.();
    };
    return { frame, given, pending: () => looks.length };
  }

  it("the page told late that the frame has the focus: given back when it is, not only at the first look", () => {
    const at = { holds: false };
    const w = watch(at);
    w.frame();
    w.frame();
    expect(w.given).toEqual([]);
    at.holds = true;
    w.frame();
    expect(w.given).toHaveLength(1);
  });

  it("the browser moving its focus into the frame again after it was given back: given back again", () => {
    const at = { holds: true };
    const w = watch(at);
    w.frame();
    expect(w.given).toHaveLength(1);
    at.holds = true;
    w.frame();
    expect(w.given).toHaveLength(2);
  });

  it("the person (or the host) put the focus there meanwhile: left where it is, the watch ends", () => {
    const at = { holds: true, placed: true };
    const w = watch(at);
    w.frame();
    expect(w.given).toEqual([]);
    expect(w.pending()).toBe(0);
  });

  it("a newer grab of the same frame watched instead: this watch ends", () => {
    const at = { holds: true, current: false };
    const w = watch(at);
    w.frame();
    expect(w.given).toEqual([]);
    expect(w.pending()).toBe(0);
  });

  it("ends past its deadline: the focus moved there after it stays", () => {
    const at = { holds: false };
    const w = watch(at);
    for (let i = 0; i < 1000 && w.pending() > 0; i++) w.frame(100);
    expect(w.pending()).toBe(0);
    expect(w.given).toEqual([]);
    expect(GIVE_BACK_MS).toBeGreaterThanOrEqual(1000);
  });
});
