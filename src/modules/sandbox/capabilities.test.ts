import { describe, expect, it } from "vitest";
import { SURFACES } from "@/components/app/surface";
import { capabilityMethods, type CapabilityDeps } from "./capabilities";
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
    expect(Object.keys(methods).filter(n => !methods[n]?.cap)).toEqual(["unwatch", "look"]);
  });

  it("a module that posts the call itself is refused each one it did not declare", async () => {
    const { methods } = capabilityMethods(deps);
    const frame = {};
    const refused: string[] = [];
    const peer = createRpcPeer({ source: () => frame, post() {}, capabilities: [], methods, onRefused: (why, m) => why === "capability" && m && refused.push(m) });
    let id = 0;
    for (const m of Object.keys(methods)) peer.receive({ source: frame, origin: "null", data: { v: 1, t: "call", id: ++id, m, a: [] } });
    expect(refused.sort()).toEqual(Object.keys(methods).filter(n => n !== "unwatch" && n !== "look").sort());
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
