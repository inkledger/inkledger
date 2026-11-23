import { describe, expect, it } from "vitest";
import { SURFACES } from "@/components/app/surface";
import { capabilityMethods, PICTURE_MAX_BYTES, type CapabilityDeps } from "./capabilities";
import { createPageLight } from "./light";
import { createRpcPeer } from "./rpc";

const unused = (): never => {
  throw new Error("not reached");
};
const deps = {
  moduleId: "m",
  view: { el: { dataset: {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) } as unknown as HTMLElement, slot: "dashboard-overlay", activate() {} },
  light: createPageLight({ root: { setProperty() {}, removeProperty() {} }, addStyle: () => ({ remove() {} }) }, SURFACES),
  broker: { active: () => true, share: unused, download: unused, openImage: unused, here: unused },
  page: unused,
  pointer: { watch: unused },
  layout: { watch: unused, poke() {} },
  blur: unused,
  cache: { get: unused, put: unused, delete: unused },
  look: { watch: () => () => {}, fonts: async () => null },
  sheet: { open: unused, close: unused },
} as unknown as CapabilityDeps;

describe("capabilities, held by the host", () => {
  it("every member past the basics names its capability", () => {
    const { methods } = capabilityMethods(deps);
    expect(Object.keys(methods).filter(n => !methods[n]?.cap)).toEqual(["unwatch", "layoutChanged", "look"]);
  });

  it("a module that posts the call itself is refused each one it did not declare", async () => {
    const { methods } = capabilityMethods(deps);
    const frame = {};
    const refused: string[] = [];
    const peer = createRpcPeer({ source: () => frame, post() {}, capabilities: [], methods, onRefused: (why, m) => why === "capability" && m && refused.push(m) });
    let id = 0;
    for (const m of Object.keys(methods)) peer.receive({ source: frame, origin: "null", data: { v: 1, t: "call", id: ++id, m, a: [] } });
    expect(refused.sort()).toEqual(Object.keys(methods).filter(n => n !== "unwatch" && n !== "look" && n !== "layoutChanged").sort());
  });

  it("the cache is the account's as well as the module's: the next account on the device never reads the last one's", async () => {
    const rows = new Map<string, Blob>();
    const cache = {
      get: async (m: string, k: string) => rows.get(`${m}|${k}`) ?? null,
      put: async (m: string, k: string, b: Blob) => void rows.set(`${m}|${k}`, b),
      delete: async () => {},
    };
    let account: number | null = 1;
    const { methods } = capabilityMethods({ ...deps, cache: cache as unknown as CapabilityDeps["cache"], account: () => account });
    const frame = {};
    const res: unknown[] = [];
    const peer = createRpcPeer({ source: () => frame, post: m => m.t === "res" && res.push(m.ok ? m.value : m.error), capabilities: ["cache"], methods });
    const call = async (id: number, m: string, a: unknown[]) => {
      peer.receive({ source: frame, origin: "null", data: { v: 1, t: "call", id, m, a } });
      await new Promise(r => setTimeout(r, 0));
    };
    await call(1, "cache.put", ["render", new Blob(["the first account's picture"])]);
    await call(2, "cache.get", ["render"]);
    account = 2;
    await call(3, "cache.get", ["render"]);
    account = null;
    await call(4, "cache.get", ["render"]);
    expect(res[1]).toBeInstanceOf(Blob);
    expect(res.slice(2)).toEqual([null, "cache: signed out"]);
  });

  it("a large file to save goes past the picture cap, only with its own capability", async () => {
    const saved: [number, string][] = [];
    const { methods } = capabilityMethods({ ...deps, broker: { ...deps.broker, downloadLarge: async (f: Blob, name: string) => void saved.push([f.size, name]) } });
    const frame = {};
    const res: unknown[] = [];
    const peer = (caps: string[]) => createRpcPeer({ source: () => frame, post: m => m.t === "res" && res.push(m.ok ? "ok" : m.error), capabilities: caps as never, methods });
    const film = new Blob([new Uint8Array(PICTURE_MAX_BYTES + 1)]);
    peer(["download"]).receive({ source: frame, origin: "null", data: { v: 1, t: "call", id: 1, m: "download.large", a: [film, "film"] } });
    peer(["download", "download.large"]).receive({ source: frame, origin: "null", data: { v: 1, t: "call", id: 2, m: "download", a: [film, "film"] } });
    peer(["download.large"]).receive({ source: frame, origin: "null", data: { v: 1, t: "call", id: 3, m: "download.large", a: [film, "film"] } });
    await new Promise(r => setTimeout(r, 0));
    expect(res).toEqual(["capability", "bad-arguments", "ok"]);
    expect(saved).toEqual([[PICTURE_MAX_BYTES + 1, "film"]]);
  });

  it("the look is sent again only when it changed", async () => {
    let tell: (css: string) => void = () => {};
    const { methods } = capabilityMethods({ ...deps, look: { watch: push => ((tell = push), () => {}), fonts: async () => null } });
    const frame = {};
    const pushed: unknown[] = [];
    const peer = createRpcPeer({ source: () => frame, post: m => m.t === "push" && pushed.push(m.value), capabilities: [], methods });
    peer.receive({ source: frame, origin: "null", data: { v: 1, t: "call", id: 1, m: "look", a: [7] } });
    await new Promise(r => setTimeout(r, 0));
    tell("a");
    tell("a");
    tell("b");
    expect(pushed).toEqual([{ tokens: "a" }, { tokens: "b" }]);
  });
});
