import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRateBuckets, createRpcPeer, messageBytes, method, RPC_MAX_BYTES, type HostMessage } from "./rpc";

const frame = { name: "frame" };
const other = { name: "another frame" };

function peer(capabilities: string[] = []) {
  let t = 0;
  const sent: HostMessage[] = [];
  const refused: string[] = [];
  const p = createRpcPeer({
    source: () => frame,
    post: m => sent.push(m),
    capabilities: capabilities as never,
    now: () => t,
    onRefused: why => refused.push(why),
    methods: {
      echo: method({ args: z.tuple([z.string().max(10)]), rate: [2, 3], run: ([s]) => s.toUpperCase() }),
      dock: method({ args: z.tuple([z.boolean()]), cap: "dock", rate: [10, 10], run: () => "docked" }),
    },
  });
  const call = (m: string, a: unknown[], id = 1, source: unknown = frame, origin = "null") => p.receive({ source, origin, data: { v: 1, t: "call", id, m, a } });
  return { p, sent, refused, call, tick: (ms: number) => (t += ms) };
}

const settle = () => new Promise(r => setTimeout(r, 0));

describe("framed module messages", () => {
  it("answers a declared call from its own frame", async () => {
    const { call, sent } = peer();
    expect(call("echo", ["hi"], 7)).toEqual({ ok: true });
    await settle();
    expect(sent).toEqual([{ v: 1, t: "res", id: 7, ok: true, value: "HI" }]);
  });

  it("hands a frame's heartbeat to the watchdog, and drops a malformed one", () => {
    const beats: number[] = [];
    const p = createRpcPeer({ source: () => frame, post: () => {}, capabilities: [], methods: {}, onBeat: b => beats.push(b) });
    expect(p.receive({ source: frame, origin: "null", data: { v: 1, t: "beat", busy: 120 } })).toEqual({ ok: true });
    expect(p.receive({ source: frame, origin: "null", data: { v: 1, t: "beat", busy: -1 } })).toEqual({ ok: false, why: "schema" });
    expect(p.receive({ source: other, origin: "null", data: { v: 1, t: "beat", busy: 0 } })).toEqual({ ok: false, why: "source" });
    expect(beats).toEqual([120]);
  });

  it("reads nothing from another window, nor from a frame whose window is gone", () => {
    const { call, sent, refused } = peer();
    expect(call("echo", ["hi"], 1, other)).toEqual({ ok: false, why: "source" });
    expect(call("echo", ["hi"], 1, null)).toEqual({ ok: false, why: "source" });
    const gone = createRpcPeer({ source: () => null, post: () => {}, capabilities: [], methods: {} });
    expect(gone.receive({ source: null, origin: "null", data: { v: 1, t: "ready" } })).toEqual({ ok: false, why: "source" });
    // Not this peer's business: not even counted as a refusal.
    expect(sent).toEqual([]);
    expect(refused).toEqual([]);
  });

  it("only from an opaque origin", () => {
    expect(peer().call("echo", ["hi"], 1, frame, "http://localhost")).toEqual({ ok: false, why: "origin" });
  });

  it("drops an oversized message unread", () => {
    const { call, sent } = peer();
    expect(call("echo", ["x".repeat(RPC_MAX_BYTES)])).toEqual({ ok: false, why: "size" });
    expect(call("echo", [new Array(5000).fill(1)])).toEqual({ ok: false, why: "size" });
    expect(call("echo", [new Blob([new Uint8Array(RPC_MAX_BYTES + 1)])])).toEqual({ ok: false, why: "size" });
    expect(sent).toEqual([]);
  });

  it("refuses what may not cross: an OffscreenCanvas, class instances, functions", () => {
    class OffscreenCanvas {}
    const g = globalThis as Record<string, unknown>;
    const had = g.OffscreenCanvas;
    g.OffscreenCanvas = OffscreenCanvas;
    try {
      expect(messageBytes({ canvas: new OffscreenCanvas() })).toBeNull();
    } finally {
      g.OffscreenCanvas = had;
    }
    expect(messageBytes({ at: new Date() })).toBeNull();
    expect(messageBytes([() => 1])).toBeNull();
    expect(messageBytes({ bytes: new Uint8Array(10), blob: new Blob(["abc"]) })).toBeGreaterThan(10);
  });

  it("refuses a malformed message or a wrong version", () => {
    const { p } = peer();
    expect(p.receive({ source: frame, origin: "null", data: { v: 2, t: "ready" } })).toEqual({ ok: false, why: "schema" });
    expect(p.receive({ source: frame, origin: "null", data: { v: 1, t: "call", id: 1, m: "echo", a: [], extra: 1 } })).toEqual({ ok: false, why: "schema" });
    expect(p.receive({ source: frame, origin: "null", data: "ready" })).toEqual({ ok: false, why: "schema" });
  });

  it("answers an unknown method with an error, including the object's own keys", async () => {
    const { call, sent } = peer();
    expect(call("nope", [], 3)).toEqual({ ok: false, why: "unknown-method" });
    expect(call("constructor", [], 4)).toEqual({ ok: false, why: "unknown-method" });
    expect(sent).toEqual([
      { v: 1, t: "res", id: 3, ok: false, error: "unknown-method" },
      { v: 1, t: "res", id: 4, ok: false, error: "unknown-method" },
    ]);
  });

  it("holds each call to the capabilities the manifest declares", async () => {
    expect(peer().call("dock", [true])).toEqual({ ok: false, why: "capability" });
    const declared = peer(["dock"]);
    expect(declared.call("dock", [true])).toEqual({ ok: true });
    await settle();
    expect(declared.sent).toEqual([{ v: 1, t: "res", id: 1, ok: true, value: "docked" }]);
  });

  it("rate-limits each method, refilling with time", () => {
    const { call, tick } = peer();
    expect([1, 2, 3, 4].map(id => call("echo", ["a"], id).ok)).toEqual([true, true, true, false]);
    tick(500);
    expect(call("echo", ["a"], 5).ok).toBe(true);
    expect(call("echo", ["a"], 6).ok).toBe(false);
  });

  it("a costly method's rate is the module's: its frames share it", () => {
    const shared = createRateBuckets();
    const methods = {
      geocode: method({ args: z.tuple([]), rate: [1, 2], shared: true, run: () => null }),
      local: method({ args: z.tuple([]), rate: [1, 2], run: () => null }),
    };
    const views = [{ name: "view a" }, { name: "view b" }].map(source => ({
      source,
      p: createRpcPeer({ source: () => source, post: () => {}, capabilities: [], methods, now: () => 0, buckets: shared }),
    }));
    const call = (i: number, m: string) => views[i]?.p.receive({ source: views[i]?.source, origin: "null", data: { v: 1, t: "call", id: 1, m, a: [] } }).ok;
    expect([call(0, "geocode"), call(0, "geocode"), call(1, "geocode")]).toEqual([true, true, false]);
    expect([call(0, "local"), call(0, "local"), call(1, "local")]).toEqual([true, true, true]);
  });

  it("refuses arguments outside the method's schema", async () => {
    const { call, sent } = peer();
    call("echo", ["far too long a string"], 9);
    call("echo", [42], 10);
    await settle();
    expect(sent).toEqual([
      { v: 1, t: "res", id: 9, ok: false, error: "bad-arguments" },
      { v: 1, t: "res", id: 10, ok: false, error: "bad-arguments" },
    ]);
  });

  it("goes quiet once disposed and lets go of what it held", async () => {
    let held = 0;
    const sent: HostMessage[] = [];
    const p = createRpcPeer({
      source: () => frame,
      post: m => sent.push(m),
      capabilities: [],
      methods: { sub: method({ args: z.tuple([]), rate: [10, 10], run: (_a, ctx) => void ctx.own(() => held++) }) },
    });
    p.receive({ source: frame, origin: "null", data: { v: 1, t: "call", id: 1, m: "sub", a: [] } });
    await settle();
    p.dispose();
    expect(held).toBe(1);
    expect(p.receive({ source: frame, origin: "null", data: { v: 1, t: "ready" } })).toEqual({ ok: false, why: "disposed" });
    p.send({ v: 1, t: "activate" });
    expect(sent).toEqual([{ v: 1, t: "res", id: 1, ok: true, value: null }]);
  });
});
