import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clockNow, subscribeClock } from "./clock";

describe("shared clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it("one interval for every listener, all told in the same tick", () => {
    const calls: string[] = [];
    const offA = subscribeClock(1000, () => calls.push(`a${clockNow(1000)}`));
    const offB = subscribeClock(1000, () => calls.push(`b${clockNow(1000)}`));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(calls).toEqual(["a1001000", "b1001000", "a1002000", "b1002000"]);
    offA();
    offB();
  });

  it("stops with its last listener; a new one reads the time afresh", () => {
    const off = subscribeClock(1000, () => {});
    off();
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(5_000_000);
    const again = subscribeClock(1000, () => {});
    expect(clockNow(1000)).toBe(5_000_000);
    again();
  });

  it("periods are separate clocks", () => {
    const seen: number[] = [];
    const off1 = subscribeClock(1000, () => seen.push(1));
    const off30 = subscribeClock(30_000, () => seen.push(30));
    vi.advanceTimersByTime(30_000);
    expect(seen.filter(s => s === 1)).toHaveLength(30);
    expect(seen.filter(s => s === 30)).toHaveLength(1);
    off1();
    off30();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a listener leaving during a tick does not stop the others", () => {
    const seen: string[] = [];
    let offA = () => {};
    offA = subscribeClock(1000, () => {
      seen.push("a");
      offA();
    });
    const offB = subscribeClock(1000, () => seen.push("b"));
    vi.advanceTimersByTime(2000);
    expect(seen).toEqual(["a", "b", "b"]);
    offB();
  });
});
