import { describe, expect, it } from "vitest";
import type { HostApiV1, TimerState } from "../types";
import { frameMethods, onMask, type Cas } from "./methods";
import { createRpcPeer, type HostMessage } from "./rpc";

const frame = {};
const settle = () => new Promise(r => setTimeout(r, 0));

function setup({ capabilities = [] as string[], conflict = false } = {}) {
  const timerFns = new Set<(t: TimerState) => void>();
  const api = {
    timer: (fn: (t: TimerState) => void) => {
      timerFns.add(fn);
      fn({ state: "idle", issueKey: null });
      return () => void timerFns.delete(fn);
    },
    storage: { get: () => Promise.resolve(null), set: () => Promise.resolve(), delete: () => Promise.resolve() },
  } as unknown as HostApiV1;
  const cas: Cas = {
    read: () => Promise.resolve({ value: 1, revision: 3 }),
    setIf: () => Promise.resolve(conflict ? { conflict: true as const, value: 5, revision: 4 } : { revision: 4 }),
  };
  const el = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
  const served = frameMethods(api, cas, { el, slot: "mobile-dock", activate: () => {} });
  const sent: HostMessage[] = [];
  const peer = createRpcPeer({ source: () => frame, post: m => sent.push(m), capabilities: capabilities as never, methods: served.methods });
  const call = (id: number, m: string, a: unknown[]) => peer.receive({ source: frame, origin: "null", data: { v: 1, t: "call", id, m, a } });
  return { sent, call, timerFns, el, peer };
}

describe("the host API a framed module reaches", () => {
  it("pushes a subscription's value at once and on every change, until unsubscribed", async () => {
    const { sent, call, timerFns } = setup();
    call(1, "sub", [100, "timer"]);
    await settle();
    expect(sent).toContainEqual({ v: 1, t: "push", id: 100, value: { state: "idle", issueKey: null } });
    [...timerFns].forEach(fn => fn({ state: "running", issueKey: "A-1" }));
    expect(sent).toContainEqual({ v: 1, t: "push", id: 100, value: { state: "running", issueKey: "A-1" } });
    call(2, "unsub", [100]);
    await settle();
    expect(timerFns.size).toBe(0);
  });

  it("lets go of subscriptions when the frame goes", async () => {
    const { call, timerFns, peer } = setup();
    call(1, "sub", [100, "timer"]);
    await settle();
    peer.dispose();
    expect(timerFns.size).toBe(0);
  });

  it("pushes the watchdog's budget for the module, and every change of it", async () => {
    const fns = new Set<(b: "normal" | "reduce" | "still") => void>();
    const served = frameMethods({} as HostApiV1, { read: () => Promise.reject(new Error()), setIf: () => Promise.reject(new Error()) }, null, fn => {
      fns.add(fn);
      fn("normal");
      return () => void fns.delete(fn);
    });
    const sent: HostMessage[] = [];
    const p = createRpcPeer({ source: () => frame, post: m => sent.push(m), capabilities: [], methods: served.methods });
    p.receive({ source: frame, origin: "null", data: { v: 1, t: "call", id: 1, m: "sub", a: [9, "budget"] } });
    await settle();
    fns.forEach(fn => fn("reduce"));
    expect(sent.filter(m => m.t === "push")).toEqual([
      { v: 1, t: "push", id: 9, value: "normal" },
      { v: 1, t: "push", id: 9, value: "reduce" },
    ]);
    p.dispose();
    expect(fns.size).toBe(0);
  });

  it("refuses an event the host does not have", async () => {
    const { sent, call } = setup();
    call(1, "sub", [100, "event", "keydown"]);
    await settle();
    expect(sent).toEqual([{ v: 1, t: "res", id: 1, ok: false, error: "bad-arguments" }]);
  });

  it("storage: a conditional write says when someone wrote meanwhile, with what they wrote", async () => {
    const ok = setup();
    ok.call(1, "storage.setIf", ["k", 2, 3]);
    await settle();
    expect(ok.sent).toEqual([{ v: 1, t: "res", id: 1, ok: true, value: { ok: true } }]);
    const lost = setup({ conflict: true });
    lost.call(1, "storage.setIf", ["k", 2, 3]);
    await settle();
    expect(lost.sent).toEqual([{ v: 1, t: "res", id: 1, ok: true, value: { ok: false, value: 5, revision: 4 } }]);
  });

  it("dock.set only with its capability", async () => {
    const without = setup();
    without.call(1, "dock.set", [true]);
    expect(without.el.dataset.docked).toBeUndefined();
    const declared = setup({ capabilities: ["dock"] });
    declared.call(1, "dock.set", [true]);
    await settle();
    expect(declared.el.dataset.docked).toBe("");
  });

  it("hit.set takes an alpha mask over the box, only one whose size it says", async () => {
    const { sent, call } = setup();
    call(1, "hit.set", [{ kind: "mask", w: 2, h: 2, alpha: new Uint8Array([0, 255, 0, 0]) }]);
    call(2, "hit.set", [{ kind: "mask", w: 2, h: 2, alpha: new Uint8Array(3) }]);
    call(3, "hit.set", [{ kind: "mask", w: 600, h: 1, alpha: new Uint8Array(600) }]);
    await settle();
    expect(sent).toEqual([
      { v: 1, t: "res", id: 2, ok: false, error: "bad-arguments" },
      { v: 1, t: "res", id: 3, ok: false, error: "bad-arguments" },
      { v: 1, t: "res", id: 1, ok: true, value: null },
    ]);
  });

  it("a mask is stretched over its box; faint edges let the page keep the click", () => {
    const m = { w: 2, h: 2, alpha: new Uint8Array([0, 255, 20, 0]) };
    expect(onMask(m, 150, 10, 200, 100)).toBe(true);
    expect(onMask(m, 50, 10, 200, 100)).toBe(false);
    expect(onMask(m, 50, 90, 200, 100)).toBe(false);
    expect(onMask(m, 199.9, 0, 200, 100)).toBe(true);
    expect(onMask(m, 10, 10, 0, 0)).toBe(false);
  });
});
