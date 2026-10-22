import { describe, expect, it } from "vitest";
import { keyedLock, singleFlight } from "./locks";

const tick = () => new Promise(r => setTimeout(r, 0));
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe("keyedLock", () => {
  it("runs one key's calls one after the other, in order; other keys alongside", async () => {
    const tails = new Map<number, Promise<unknown>>();
    const run = keyedLock(tails);
    const log: string[] = [];
    const a = deferred();
    const first = run(1, async () => (log.push("a start"), await a.promise, log.push("a end"), "a"));
    const second = run(1, async () => (log.push("b"), "b"));
    const other = run(2, async () => (log.push("other"), "o"));
    await tick();
    expect(log).toEqual(["a start", "other"]);
    a.resolve();
    expect(await Promise.all([first, second, other])).toEqual(["a", "b", "o"]);
    expect(log).toEqual(["a start", "other", "a end", "b"]);
    await tick();
    expect(tails.size).toBe(0);
  });

  it("a failure is its caller's alone: the queue goes on", async () => {
    const run = keyedLock<string>();
    const failed = run("k", async () => {
      throw new Error("no");
    });
    const next = run("k", async () => "yes");
    await expect(failed).rejects.toThrow("no");
    await expect(next).resolves.toBe("yes");
  });

  it("a key queued again after it emptied starts at once", async () => {
    const tails = new Map<string, Promise<unknown>>();
    const run = keyedLock(tails);
    await run("k", async () => 1);
    await tick();
    expect(tails.has("k")).toBe(false);
    let started = false;
    const again = run("k", async () => (started = true));
    await tick();
    expect(started).toBe(true);
    await again;
  });
});

describe("singleFlight", () => {
  it("asks under way share one run; once settled the next starts anew", async () => {
    const flight = singleFlight<string, number>();
    let starts = 0;
    const d = deferred<number>();
    const one = flight.run("k", () => (starts++, d.promise));
    const two = flight.run("k", () => (starts++, Promise.resolve(99)));
    expect(one).toBe(two);
    expect(flight.pending()).toHaveLength(1);
    d.resolve(7);
    expect(await two).toBe(7);
    expect(flight.pending()).toHaveLength(0);
    expect(await flight.run("k", () => (starts++, Promise.resolve(8)))).toBe(8);
    expect(starts).toBe(2);
  });

  it("a failed run is shared too, and forgotten", async () => {
    const flight = singleFlight<number, string>();
    const d = deferred<string>();
    const one = flight.run(1, () => d.promise);
    const two = flight.run(1, () => Promise.resolve("never"));
    d.reject(new Error("down"));
    await expect(one).rejects.toThrow("down");
    await expect(two).rejects.toThrow("down");
    await expect(flight.run(1, () => Promise.resolve("again"))).resolves.toBe("again");
  });

  it("keys are apart", async () => {
    const flight = singleFlight<number, number>();
    const a = flight.run(1, () => Promise.resolve(1));
    const b = flight.run(2, () => Promise.resolve(2));
    expect(a).not.toBe(b);
    expect(await Promise.all([a, b])).toEqual([1, 2]);
  });
});
