import { describe, expect, it } from "vitest";
import { SURFACES } from "@/components/app/surface";
import { z } from "zod";
import { capabilityMethods, type CapabilityDeps } from "./capabilities";
import { method, RPC_VERSION } from "./rpc";
import { createPageLight } from "./light";
import { createBroker, type BrokerEnv } from "./broker";
import { createModuleCache, type CacheBackend } from "./cache";
import { sheetOpen } from "./sheet";
import type { ImportancePage } from "./importance";
import type { ViewBox } from "./methods";
import { bootFrame, settle } from "./bootFrame.testkit";
import type { HostApiV2, LayoutState } from "../hostV2";
import { PICTURE_MAX_BYTES, type ModuleCapability } from "@contracts/modules";

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

const feeds = {
  pointer: { watch: (_r: unknown, push: (v: { x: number; y: number } | null) => void) => (push({ x: 1, y: 2 }), () => {}) },
  layout: { poke() {}, watch: (push: (v: LayoutState) => void) => (push({ sidebar: "rail", docked: false }), () => {}) },
  blur: (_b: Element, push: (px: number) => void) => (push(5), () => {}),
} as unknown as Pick<CapabilityDeps, "pointer" | "layout" | "blur">;

function memoryCache(): CacheBackend {
  const rows = new Map<string, { value: Blob; at: number }>();
  return {
    get: async (m, k) => rows.get(m + "/" + k)?.value ?? null,
    put: async (m, k, value, at) => void rows.set(m + "/" + k, { value, at }),
    delete: async (m, k) => void rows.delete(m + "/" + k),
    entries: async () => [],
  };
}

const look = { watch: (push: (css: string) => void) => (push(":root{--primary:1 2% 3%}"), () => {}), fonts: async () => "@font-face{}" };

const emptyPage: ImportancePage = {
  width: 100,
  height: 100,
  documentElement: {} as HTMLElement,
  body: {} as HTMLElement,
  elementFromPoint: () => null,
  createRange: () => ({}) as Range,
  style: () => ({ cursor: "auto", backgroundColor: "" }),
};

function withModule(
  capabilities: ModuleCapability[],
  mount: (el: unknown, host: HostApiV2) => void,
  env: BrokerEnv = quietEnv,
  view: ViewBox | null = null,
) {
  const { doc, props } = lightDoc();
  const caps = capabilityMethods({ moduleId: "m", view, light: createPageLight(doc, SURFACES), broker: createBroker(env), page: () => emptyPage, ...feeds, cache: createModuleCache(memoryCache()), look, sheet: sheetOpen });
  const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": (el: unknown, host: HostApiV2) => (mount(el, host), () => {}) } };
  return { ...bootFrame({ capabilities, mod, methods: caps.methods }), props, caps };
}

describe("the frame's host API (bootstrap)", () => {
  it("surfaces.light reaches the page's light, only with its capability", async () => {
    let seen: HostApiV2 | null = null;
    const f = withModule(["surfaces.light"], (_el, host) => {
      seen = host;
      void host.surfaces?.light?.({ "--sky-dim": "0.25" });
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

  it("surfaces.light: casts in a burst reach the host once, the latest winning; a refused one rejects in the frame", async () => {
    const results: unknown[] = [];
    const f = withModule(["surfaces.light"], (_el, host) => {
      void host.surfaces?.light?.({ "--sky-dim": "0.1" }).then(() => results.push("first"));
      void host.surfaces?.light?.({ "--sky-dim": "0.2" }, ["card"]).then(() => results.push("second"));
    });
    await settle(10);
    // Answers: the look's watch, and one light.
    expect(f.sent.filter(m => m.t === "res")).toHaveLength(2);
    expect(f.props.get("--sky-dim")).toBe("0.2");
    expect(results).toEqual(["first", "second"]);

    const errors: string[] = [];
    withModule(["surfaces.light"], (_el, host) => {
      void host.surfaces?.light?.({ "--sky-dim": "2" }).catch((e: Error) => errors.push(e.message));
      setTimeout(() => void host.surfaces?.light?.({ "--sky-dim": "0.5" }, ["nope"]).catch((e: Error) => errors.push(e.message)), 40);
    });
    await new Promise(r => setTimeout(r, 80));
    await settle(10);
    expect(errors).toEqual(["light: --sky-dim refused", "light: an unknown surface kind refused"]);
  });

  it("page.importance: the box's points, off the page counting as important", async () => {
    const el = { dataset: {}, getBoundingClientRect: () => ({ left: 90, top: 0, width: 0, height: 0 }) } as unknown as HTMLElement;
    let out: unknown = null;
    withModule(["page.importance"], (_el, host) => void host.page?.importance([[5, 5], [20, 5]]).then(r => (out = r)), quietEnv, { el, slot: "panel-edge", activate() {} });
    await settle();
    expect(out).toEqual([0, 1]);
  });

  it("share hands the host a picture; one over the message cap is refused in the frame, never left hanging", async () => {
    const shared: File[] = [];
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]);
    const results: unknown[] = [];
    withModule(
      ["share"],
      (_el, host) => {
        void host.share?.(png, "pic").then(r => results.push(r));
        void host.share?.(new Blob([new Uint8Array(PICTURE_MAX_BYTES + 1)]), "big").catch((e: Error) => results.push(e.message));
      },
      { ...quietEnv, share: async f => (shared.push(f), true) },
    );
    await settle(10);
    expect(results).toEqual(expect.arrayContaining([true, "share: too big to send"]));
    expect(shared[0]).toMatchObject({ name: "pic.png", type: "image/png" });
  });

  it("a large picture (a 2.3 MB PNG, and one right at the cap) is downloaded whole", async () => {
    const saved: Blob[] = [];
    const pngOf = (n: number) => {
      const b = new Uint8Array(n);
      b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      return new Blob([b]);
    };
    const results: unknown[] = [];
    withModule(
      ["download"],
      (_el, host) => {
        for (const n of [2_300_000, PICTURE_MAX_BYTES]) void host.download?.(pngOf(n), "week").then(() => results.push(n), (e: Error) => results.push(e.message));
      },
      { ...quietEnv, download: f => void saved.push(f) },
    );
    await settle(16);
    expect(results.sort()).toEqual([2_300_000, PICTURE_MAX_BYTES].sort());
    expect(saved.map(b => [b.size, b.type])).toEqual([
      [2_300_000, "image/png"],
      [PICTURE_MAX_BYTES, "image/png"],
    ]);
  });

  it("hit.set with a picture sends its alpha, scaled to 512 px a side at most", async () => {
    const got: unknown[] = [];
    const methods = { "hit.set": method({ args: z.tuple([z.unknown()]), rate: [10, 10], run: ([m]) => void got.push(m) }) };
    class OffscreenCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        const n = this.width * this.height;
        return { drawImage() {}, getImageData: () => ({ data: Uint8ClampedArray.from({ length: n * 4 }, (_, i) => (i % 4 === 3 && i < 8 ? 200 : 0)) }) };
      }
    }
    const mod = { id: "m", hostApi: 2, mount: { "dashboard-overlay": (_el: unknown, host: HostApiV2) => (host.hit.set({ width: 1024, height: 256 } as ImageBitmap, () => {}), () => {}) } };
    bootFrame({ capabilities: [], mod, methods, slot: "dashboard-overlay", globals: { OffscreenCanvas } });
    await settle();
    const m = got[0] as { kind: string; w: number; h: number; alpha: Uint8Array };
    expect(m).toMatchObject({ kind: "mask", w: 512, h: 128 });
    expect(m.alpha).toBeInstanceOf(Uint8Array);
    expect([...m.alpha.slice(0, 3)]).toEqual([200, 200, 0]);
  });

  it("pointer, layout and blur arrive as subscriptions, each with its capability, pointer and blur in a view only", async () => {
    const el = { dataset: {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) } as unknown as HTMLElement;
    const got: unknown[] = [];
    withModule(
      ["pointer", "layout", "backdrop.preblurred"],
      (_el, host) => {
        host.pointer?.(v => got.push(["pointer", v]));
        host.layout?.(v => got.push(["layout", v]));
        host.backdrop?.blur(v => got.push(["blur", v]));
      },
      quietEnv,
      { el, slot: "dashboard-backdrop", activate() {} },
    );
    await settle();
    expect(got).toEqual(expect.arrayContaining([["pointer", { x: 1, y: 2 }], ["layout", { sidebar: "rail", docked: false }], ["blur", 5]]));

    const none: string[] = [];
    withModule(["layout"], (_el, host) => none.push(String(host.pointer), String(host.layout)));
    await settle();
    expect(none[0]).toBe("undefined");
    expect(none[1]).not.toBe("undefined");
  });

  it("cache: what a module puts, it gets back", async () => {
    let back: Blob | null = null;
    withModule(["cache"], (_el, host) => {
      void host.cache?.put("strip", new Blob(["abc"])).then(() => host.cache?.get("strip").then(b => (back = b)));
    });
    await settle(12);
    expect(back).not.toBeNull();
    expect(await (back as Blob | null)?.text()).toBe("abc");
  });

  it("the app's look reaches every frame: tokens, then fonts", async () => {
    let atMount = "";
    const f = withModule([], () => (atMount = "mounted"));
    await settle(12);
    expect(atMount).toBe("mounted");
    expect(f.styles.get("ikl-theme")?.textContent).toBe(":root{--primary:1 2% 3%}");
    expect(f.styles.get("ikl-fonts")?.textContent).toBe("@font-face{}");
  });

  it("sheet: opened on the person's gesture only, closed by its module or by Esc in its frame", async () => {
    withModule(["sheet"], (_el, host) => host.sheet?.open(), { ...quietEnv, active: () => false });
    await settle();
    expect(sheetOpen.get()).toBeNull();
    withModule(["sheet"], (_el, host) => host.sheet?.open());
    await settle();
    expect(sheetOpen.get()).toBe("m");
    sheetOpen.open("other");
    withModule(["sheet"], (_el, host) => host.sheet?.close());
    await settle();
    expect(sheetOpen.get()).toBe("other");
    sheetOpen.open("m");
    const caps = ["sheet"] as ModuleCapability[];
    const { doc } = lightDoc();
    const methods = capabilityMethods({ moduleId: "m", view: null, light: createPageLight(doc, SURFACES), broker: createBroker(quietEnv), page: () => emptyPage, ...feeds, cache: createModuleCache(memoryCache()), look, sheet: sheetOpen }).methods;
    const mod = { id: "m", hostApi: 2, mount: { sheet: () => () => {} } };
    const frame = bootFrame({ capabilities: caps, mod, methods, slot: "sheet" });
    await settle();
    frame.keydown("Escape");
    await settle();
    expect(sheetOpen.get()).toBeNull();
  });

  it("unmount: the view's cleanup runs, then the host hears it is done", async () => {
    const order: string[] = [];
    const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": () => () => void order.push("cleanup") } };
    const f = bootFrame({ capabilities: [], mod, methods: {}, onUnmounted: () => order.push("unmounted") });
    await settle();
    f.peer.send({ v: RPC_VERSION, t: "unmount" });
    await settle();
    expect(order).toEqual(["cleanup", "unmounted"]);
  });

  it("runtime gone: a view told so falls back; refused from the start, it has no port and hears so at once", async () => {
    const heard: string[] = [];
    const watchGone = (name: string) => ({
      id: "m",
      hostApi: 2,
      mount: {
        "dashboard-widget": (_el: unknown, host: HostApiV2) => {
          heard.push(`${name}:port=${host.runtime ? "yes" : "no"}`);
          host.runtimeGone?.(() => heard.push(`${name}:gone`));
          return () => {};
        },
      },
    });
    bootFrame({ capabilities: ["runtime"], mod: watchGone("refused"), methods: {} });
    const { port1, port2 } = new MessageChannel();
    const later = bootFrame({ capabilities: ["runtime"], mod: watchGone("later"), methods: {}, port: port2 });
    await settle();
    expect(heard).toEqual(expect.arrayContaining(["refused:port=no", "refused:gone", "later:port=yes"]));
    expect(heard).not.toContain("later:gone");
    later.peer.send({ v: RPC_VERSION, t: "runtime-gone" });
    await settle();
    expect(heard).toContain("later:gone");
    port1.close();
  });

  it("a slot sized by its content: the frame tells the height of what it holds, again on every change, never the same twice", async () => {
    const sizes: number[] = [];
    let resized: (() => void) | null = null;
    class ResizeObserver {
      constructor(cb: () => void) {
        resized = cb;
      }
      observe() {}
      disconnect() {}
    }
    // A flow row, and a scroller filling the box (its content only in scrollHeight).
    const row = { offsetTop: 0, offsetHeight: 40, scrollHeight: 40 };
    const scroller = { offsetTop: 0, offsetHeight: 0, scrollHeight: 120 };
    const mod = { id: "m", hostApi: 2, mount: { settings: (el: { children?: unknown[] }) => ((el.children = [row, scroller]), () => {}) } };
    bootFrame({ capabilities: [], mod, methods: {}, slot: "settings", fit: true, onSize: h => sizes.push(h), globals: { ResizeObserver } });
    await settle(10);
    expect(sizes).toEqual([120]);
    row.offsetHeight = 200.4;
    (resized as (() => void) | null)?.();
    (resized as (() => void) | null)?.();
    await settle(10);
    expect(sizes).toEqual([120, 201]);
    (resized as (() => void) | null)?.();
    await settle(10);
    expect(sizes).toEqual([120, 201]);
  });

  it("hit shapes set faster than ten a second: the latest is the one the host gets", async () => {
    const got: unknown[] = [];
    const methods = { "hit.set": method({ args: z.tuple([z.unknown()]), rate: [10, 10], run: ([m]) => void got.push(m) }) };
    const rect = (x: number) => [{ kind: "rect", x, y: 0, w: 1, h: 1 }] as const;
    const mod = {
      id: "m",
      hostApi: 2,
      mount: {
        "dashboard-overlay": (_el: unknown, host: HostApiV2) => {
          for (let x = 1; x <= 3; x++) host.hit.set(rect(x), () => {});
          return () => {};
        },
      },
    };
    bootFrame({ capabilities: [], mod, methods, slot: "dashboard-overlay" });
    await settle(10);
    expect(got).toEqual([rect(3)]);
  });
});
