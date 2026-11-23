import { afterEach, describe, expect, it, vi } from "vitest";
import { createFocusBadge } from "./focusBadge";

const body = {};

const setup = () => {
  let active: unknown = null;
  const b = createFocusBadge<{ name: string }>(() => active);
  let told = 0;
  b.subscribe(() => told++);
  return { b, focus: (el: unknown) => ((active = el), b.check()), told: () => told };
};

afterEach(() => vi.useRealTimers());

describe("the focus badge", () => {
  it("goes when the focus left without any event to say so", () => {
    vi.useFakeTimers();
    let active: unknown = null;
    const b = createFocusBadge<{ name: string }>(() => active);
    const a = {};
    b.add(a, { name: "Stitch" });
    active = a;
    b.check();
    expect(b.get()?.name).toBe("Stitch");
    active = body;
    vi.advanceTimersByTime(300);
    expect(b.get()).toBeNull();
    // Nothing left to poll once it is gone.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("names the view the focus went into, once per entry, and goes as the focus leaves", () => {
    const { b, focus, told } = setup();
    const a = {};
    b.add(a, { name: "Stitch" });
    expect(b.get()).toBeNull();
    focus(a);
    expect(b.get()?.name).toBe("Stitch");
    // Read again with the focus still there: no new entry (nothing announced twice).
    b.check();
    expect(told()).toBe(1);
    focus(body);
    expect(b.get()).toBeNull();
    expect(told()).toBe(2);
  });

  it("follows the focus from one view to another", () => {
    const { b, focus, told } = setup();
    const a = {};
    const c = {};
    b.add(a, { name: "Stitch" });
    b.add(c, { name: "Bonsai" });
    focus(a);
    focus(c);
    expect(b.get()?.name).toBe("Bonsai");
    expect(told()).toBe(2);
  });

  it("shows nothing for what the host never added (the app, a runtime, a page module)", () => {
    const { b, focus, told } = setup();
    focus({});
    focus(null);
    focus("iframe");
    expect(b.get()).toBeNull();
    expect(told()).toBe(0);
  });

  it("goes with its frame, even one parked with the focus still in it", () => {
    const { b, focus } = setup();
    const a = {};
    const leave = b.add(a, { name: "Stitch" });
    focus(a);
    leave();
    expect(b.get()).toBeNull();
  });

  it("shows at once a frame that comes with the focus already in it", () => {
    const { b, focus } = setup();
    const a = {};
    focus(a);
    b.add(a, { name: "Stitch" });
    expect(b.get()?.name).toBe("Stitch");
  });
});
