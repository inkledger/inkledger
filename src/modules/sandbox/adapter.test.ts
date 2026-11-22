import { describe, expect, it } from "vitest";
import { SURFACES } from "@/components/app/surface";
import { capabilityMethods } from "./capabilities";
import { createPageLight } from "./light";
import { createBroker, type BrokerEnv } from "./broker";
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

const quietEnv: BrokerEnv = { active: () => true, share: async () => true, download() {}, open() {}, position: async () => null };

function withModule(capabilities: ModuleCapability[], mount: (el: unknown, host: HostApiV2) => void, env: BrokerEnv = quietEnv) {
  const { doc, props } = lightDoc();
  const caps = capabilityMethods({ moduleId: "m", view: null, light: createPageLight(doc, SURFACES), broker: createBroker(env) });
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

  it("share hands the host a picture; one over the message cap is refused in the frame, never left hanging", async () => {
    const shared: File[] = [];
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]);
    const results: unknown[] = [];
    withModule(
      ["share"],
      (_el, host) => {
        void host.share?.(png, "pic").then(r => results.push(r));
        void host.share?.(new Blob([new Uint8Array(1_100_000)]), "big").catch((e: Error) => results.push(e.message));
      },
      { ...quietEnv, share: async f => (shared.push(f), true) },
    );
    await settle(10);
    expect(results).toEqual(expect.arrayContaining([true, "share: too big to send"]));
    expect(shared[0]).toMatchObject({ name: "pic.png", type: "image/png" });
  });
});
