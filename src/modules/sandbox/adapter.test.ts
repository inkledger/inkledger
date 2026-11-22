import { describe, expect, it } from "vitest";
import { SURFACES } from "@/components/app/surface";
import { capabilityMethods } from "./capabilities";
import { createPageLight } from "./light";
import { bootFrame, settle } from "./bootFrame.testkit";
import type { HostApiV2 } from "../hostV2";
import type { ModuleCapability } from "@contracts/modules";

const lightDoc = () => {
  const props = new Map<string, string>();
  return {
    props,
    doc: {
      root: { setProperty: (k: string, v: string) => void props.set(k, v), removeProperty: (k: string) => void props.delete(k) },
      addStyle: () => ({ remove() {} }),
    },
  };
};

function withModule(capabilities: ModuleCapability[], mount: (el: unknown, host: HostApiV2) => void) {
  const { doc, props } = lightDoc();
  const caps = capabilityMethods({ moduleId: "m", view: null, light: createPageLight(doc, SURFACES) });
  const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": (el: unknown, host: HostApiV2) => (mount(el, host), () => {}) } };
  return { ...bootFrame({ capabilities, mod, methods: caps.methods }), props, caps };
}

describe("the frame's host API (bootstrap)", () => {
  it("surfaces.light reaches the page's light, only with its capability", async () => {
    let seen: HostApiV2 | null = null;
    const f = withModule(["surfaces.light"], (_el, host) => {
      seen = host;
      host.surfaces?.light?.({ "--sky-dim": "0.25" });
    });
    await settle();
    expect(seen).not.toBeNull();
    expect(f.props.get("--sky-dim")).toBe("0.25");
    f.caps.dispose();
    expect(f.props.size).toBe(0);

    let offered: boolean | null = null;
    withModule([], (_el, host) => (offered = "light" in (host.surfaces ?? {})));
    await settle();
    expect(offered).toBe(false);
  });
});
