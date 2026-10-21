import { describe, expect, it } from "vitest";
import { LruCache } from "./lruCache";

describe("LruCache", () => {
  it("keeps at most maxEntries, the least recently used out first (a read counts as use)", () => {
    const c = new LruCache<string, number>({ maxEntries: 2 });
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1);
    c.set("c", 3);
    expect([c.get("a"), c.get("b"), c.get("c")]).toEqual([1, undefined, 3]);
    expect(c.size).toBe(2);
  });

  it("caps the total size: bodies count their bytes, the oldest go to make room", () => {
    const c = new LruCache<string, Uint8Array>({ maxEntries: 100, maxSize: 10, sizeOf: (v) => v.byteLength });
    c.set("a", new Uint8Array(4));
    c.set("b", new Uint8Array(4));
    expect(c.totalSize).toBe(8);
    c.set("c", new Uint8Array(4));
    expect([c.get("a"), c.get("b")?.byteLength, c.get("c")?.byteLength]).toEqual([undefined, 4, 4]);
    expect(c.totalSize).toBe(8);
  });

  it("never keeps a value larger than the whole cap, and drops what the key held", () => {
    const c = new LruCache<string, Uint8Array>({ maxEntries: 10, maxSize: 10, sizeOf: (v) => v.byteLength });
    c.set("a", new Uint8Array(4));
    expect(c.set("a", new Uint8Array(11))).toBe(false);
    expect(c.get("a")).toBeUndefined();
    expect([c.size, c.totalSize]).toEqual([0, 0]);
  });

  it("replacing a key counts its new size only", () => {
    const c = new LruCache<string, Uint8Array>({ maxEntries: 10, maxSize: 100, sizeOf: (v) => v.byteLength });
    c.set("a", new Uint8Array(30));
    c.set("a", new Uint8Array(5));
    expect([c.size, c.totalSize]).toEqual([1, 5]);
    c.delete("a");
    expect([c.size, c.totalSize]).toEqual([0, 0]);
  });

  it("an entry past its time to live is gone on read", () => {
    let now = 1000;
    const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 50, now: () => now });
    c.set("a", 1);
    now = 1049;
    expect(c.get("a")).toBe(1);
    now = 1050;
    expect(c.get("a")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it("refuses a cap it can't honour", () => {
    expect(() => new LruCache({ maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => new LruCache({ maxEntries: 1, maxSize: 10 })).toThrow(/sizeOf/);
  });

  describe("load", () => {
    it("shares one load per key while it runs, then serves it from the cache", async () => {
      const c = new LruCache<string, number>({ maxEntries: 10 });
      let calls = 0;
      let release: (v: number) => void = () => undefined;
      const fn = () => {
        calls++;
        return new Promise<number>((r) => (release = r));
      };
      const both = Promise.all([c.load("k", fn), c.load("k", fn)]);
      release(7);
      expect(await both).toEqual([7, 7]);
      expect(await c.load("k", fn)).toBe(7);
      expect(calls).toBe(1);
    });

    it("a rejected load is never kept: every waiter sees it, the next call loads again", async () => {
      const c = new LruCache<string, number>({ maxEntries: 10 });
      let calls = 0;
      const failing = () => {
        calls++;
        return Promise.reject(new Error("down"));
      };
      const waiters = [c.load("k", failing), c.load("k", failing)];
      for (const w of waiters) await expect(w).rejects.toThrow("down");
      expect(calls).toBe(1);
      expect(c.size).toBe(0);
      expect(await c.load("k", async () => 3)).toBe(3);
    });

    it("a load resolving to undefined keeps nothing", async () => {
      const c = new LruCache<string, number>({ maxEntries: 10 });
      let calls = 0;
      const none = async () => {
        calls++;
        return undefined;
      };
      expect(await c.load("k", none)).toBeUndefined();
      expect(await c.load("k", none)).toBeUndefined();
      expect([calls, c.size]).toEqual([2, 0]);
    });

    it("clear() forgets a load still running: what it resolves to is not kept, the next call loads again", async () => {
      const c = new LruCache<string, number>({ maxEntries: 10 });
      let release: (v: number) => void = () => undefined;
      const slow = c.load("k", () => new Promise<number>((r) => (release = r)));
      c.clear();
      let calls = 0;
      const fresh = c.load("k", async () => {
        calls++;
        return 2;
      });
      release(1);
      expect(await slow).toBe(1);
      expect(await fresh).toBe(2);
      expect(calls).toBe(1);
      expect(c.get("k")).toBe(2);
    });

    it("a load that throws at once is not left running: the next call loads again", async () => {
      const c = new LruCache<string, number>({ maxEntries: 10 });
      const sync = (): Promise<number> => {
        throw new Error("at once");
      };
      await expect(c.load("k", sync)).rejects.toThrow("at once");
      expect(await c.load("k", async () => 5)).toBe(5);
    });

    it("an expired value loads again", async () => {
      let now = 0;
      const c = new LruCache<string, number>({ maxEntries: 10, ttlMs: 100, now: () => now });
      let n = 0;
      const next = async () => ++n;
      expect(await c.load("k", next)).toBe(1);
      now = 99;
      expect(await c.load("k", next)).toBe(1);
      now = 100;
      expect(await c.load("k", next)).toBe(2);
    });
  });
});
