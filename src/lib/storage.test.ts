import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceSetting, readStored, readStoredJson, writeStored } from "./storage";

/** A localStorage that works, or one the browser refuses (reads, writes, or a full quota). */
function memoryStorage({ refuse }: { refuse?: "all" | "writes" | "quota" } = {}) {
  const data = new Map<string, string>();
  const no = () => {
    throw new DOMException("The operation is insecure.", "SecurityError");
  };
  return {
    data,
    getItem: (k: string) => (refuse === "all" ? no() : (data.get(k) ?? null)),
    setItem: (k: string, v: string) => {
      if (refuse === "all" || refuse === "writes") no();
      if (refuse === "quota") throw new DOMException("full", "QuotaExceededError");
      data.set(k, v);
    },
    removeItem: (k: string) => (refuse === "all" || refuse === "writes" ? no() : void data.delete(k)),
  };
}

describe("storage primitives", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("read, write, remove", () => {
    const s = memoryStorage();
    vi.stubGlobal("localStorage", s);
    expect(readStored("k")).toBeNull();
    expect(writeStored("k", "v")).toBe(true);
    expect(readStored("k")).toBe("v");
    expect(writeStored("k", null)).toBe(true);
    expect(s.data.has("k")).toBe(false);
  });

  it("no storage at all (private mode, blocked data): reads nothing, writes refused, nothing thrown", () => {
    vi.stubGlobal("localStorage", memoryStorage({ refuse: "all" }));
    expect(readStored("k")).toBeNull();
    expect(writeStored("k", "v")).toBe(false);
    expect(writeStored("k", null)).toBe(false);
    expect(readStoredJson("k")).toBeUndefined();
  });

  it("no storage object either (a sandboxed frame): the same", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readStored("k")).toBeNull();
    expect(writeStored("k", "v")).toBe(false);
  });

  it("a full quota refuses the write, nothing thrown", () => {
    vi.stubGlobal("localStorage", memoryStorage({ refuse: "quota" }));
    expect(writeStored("k", "v")).toBe(false);
  });

  it("JSON: parsed, or undefined when missing or malformed", () => {
    const s = memoryStorage();
    vi.stubGlobal("localStorage", s);
    s.data.set("ok", '{"a":1}');
    s.data.set("bad", "{nope");
    expect(readStoredJson("ok")).toEqual({ a: 1 });
    expect(readStoredJson("bad")).toBeUndefined();
    expect(readStoredJson("none")).toBeUndefined();
  });
});

describe("deviceSetting", () => {
  afterEach(() => vi.unstubAllGlobals());
  const flag = (raw: string | null) => raw === "1";

  it("reads at start, parses malformed data to its default, stores what it is set to", () => {
    const s = memoryStorage();
    s.data.set("on", "1");
    s.data.set("junk", "maybe");
    vi.stubGlobal("localStorage", s);
    expect(deviceSetting("on", flag).get()).toBe(true);
    expect(deviceSetting("junk", flag).get()).toBe(false);
    const set = deviceSetting("missing", flag, v => (v ? "1" : "0"));
    expect(set.get()).toBe(false);
    set.set(true);
    expect([set.get(), s.data.get("missing")]).toEqual([true, "1"]);
  });

  it("format null removes the key", () => {
    const s = memoryStorage();
    s.data.set("off", "1");
    vi.stubGlobal("localStorage", s);
    const off = deviceSetting("off", flag, v => (v ? "1" : null));
    off.set(false);
    expect(s.data.has("off")).toBe(false);
  });

  it("a refused write keeps the value for this visit", () => {
    vi.stubGlobal("localStorage", memoryStorage({ refuse: "writes" }));
    const set = deviceSetting("k", flag, v => (v ? "1" : "0"));
    set.set(true);
    expect(set.get()).toBe(true);
  });

  it("another tab's write is not picked up live (read once, at start)", () => {
    const s = memoryStorage();
    vi.stubGlobal("localStorage", s);
    const set = deviceSetting("k", flag);
    s.data.set("k", "1");
    expect(set.get()).toBe(false);
  });
});
