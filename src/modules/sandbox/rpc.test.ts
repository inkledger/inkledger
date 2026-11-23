import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DOWNLOAD_LARGE_MAX_BYTES } from "@contracts/modules";
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
    expect(sent).toEqual([]);
    // A Blob past it is a handle (nothing copied): read far enough to answer that call.
    expect(call("echo", [new Blob([new Uint8Array(RPC_MAX_BYTES + 1)])], 2)).toEqual({ ok: false, why: "size" });
    expect(sent).toEqual([{ v: 1, t: "res", id: 2, ok: false, error: "size" }]);
  });

  it("a Blob past the message cap only for a method that takes a large one, up to its own cap", async () => {
    const sent: HostMessage[] = [];
    const p = createRpcPeer({
      source: () => frame,
      post: m => sent.push(m),
      capabilities: [],
      methods: {
        echo: method({ args: z.tuple([z.unknown()]), rate: [10, 10], run: () => "echo" }),
        save: method({ args: z.tuple([z.instanceof(Blob)]), large: true, rate: [10, 10], run: ([b]) => b.size }),
      },
    });
    const call = (id: number, m: string, a: unknown[]) => p.receive({ source: frame, origin: "null", data: { v: 1, t: "call", id, m, a } });
    const film = new Blob([new Uint8Array(RPC_MAX_BYTES + 1)]);
    expect(call(1, "echo", [film])).toEqual({ ok: false, why: "size" });
    // Under the cap apart, over it together: the old limit for a method that takes no large one.
    expect(call(5, "echo", [[new Blob([new Uint8Array(RPC_MAX_BYTES / 2)]), "x".repeat(RPC_MAX_BYTES / 2)]])).toEqual({ ok: false, why: "size" });
    expect(call(2, "save", [film])).toEqual({ ok: true });
    expect(call(3, "save", [new Blob([new Uint8Array(DOWNLOAD_LARGE_MAX_BYTES + 1)])])).toEqual({ ok: false, why: "size" });
    // The rest of the message keeps the usual cap.
    expect(call(4, "save", [film, "x".repeat(RPC_MAX_BYTES)])).toEqual({ ok: false, why: "size" });
    await settle();
    expect(sent.filter(m => m.t === "res" && m.ok)).toEqual([{ v: 1, t: "res", id: 2, ok: true, value: RPC_MAX_BYTES + 1 }]);
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

  it("cuts off a frame flooding the page: past its bytes or messages a second, refused ones counted too", () => {
    const floods: number[] = [];
    let t = 0;
    const p = createRpcPeer({ source: () => frame, post: () => {}, capabilities: [], methods: {}, now: () => t, onFlood: () => floods.push(t) });
    const send = (data: unknown) => {
      const r = p.receive({ source: frame, origin: "null", data });
      return r.ok ? "ok" : r.why;
    };
    // Oversized: refused unread, yet the page paid for its copy.
    const big = { v: 1, t: "call", id: 1, m: "x", a: ["x".repeat(RPC_MAX_BYTES)] };
    expect(Array.from({ length: 5 }, () => send(big))).toEqual(["size", "size", "size", "flood", "flood"]);
    t += 10_000;
    const junk = Array.from({ length: 1000 }, () => send({ v: 1, t: "junk" }));
    expect(junk.filter(w => w === "schema").length).toBeGreaterThan(100);
    expect(junk.at(-1)).toBe("flood");
    expect(floods.length).toBeGreaterThan(0);
  });

  it("an honest frame never floods: ten shapes a second and its beats", () => {
    let floods = 0;
    let t = 0;
    const p = createRpcPeer({ source: () => frame, post: () => {}, capabilities: [], methods: {}, now: () => t, onFlood: () => floods++ });
    for (let i = 0; i < 600; i++) {
      t += 100;
      p.receive({ source: frame, origin: "null", data: { v: 1, t: "call", id: i + 1, m: "hit.set", a: [{ kind: "mask", w: 512, h: 512, alpha: new Uint8Array(512 * 512) }] } });
      if (i % 5 === 0) p.receive({ source: frame, origin: "null", data: { v: 1, t: "beat", busy: 0 } });
    }
    expect(floods).toBe(0);
  });

  it("tells the host's time spent on each of its frame's messages, the handler's own included", () => {
    let t = 0;
    const costs: number[] = [];
    const p = createRpcPeer({
      source: () => frame,
      post: () => {},
      capabilities: [],
      now: () => t,
      onCost: ms => costs.push(ms),
      methods: { heavy: method({ args: z.tuple([]), rate: [10, 10], run: () => void (t += 40) }) },
    });
    p.receive({ source: frame, origin: "null", data: { v: 1, t: "call", id: 1, m: "heavy", a: [] } });
    p.receive({ source: other, origin: "null", data: { v: 1, t: "call", id: 2, m: "heavy", a: [] } });
    expect(costs).toEqual([40]);
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
