import { describe, expect, it } from "vitest";
import { SURFACES } from "@/components/app/surface";
import { z } from "zod";
import { capabilityMethods, type CapabilityDeps } from "./capabilities";
import { method, RPC_VERSION } from "./rpc";
import { createPageLight } from "./light";
import { createBroker, type BrokerEnv } from "./broker";
import { createModuleCache, type CacheBackend } from "./cache";
import { sheetOpen } from "./sheet";
import { ownReports } from "./gesture";
import type { ImportancePage } from "./importance";
import { frameMethods, type Cas, type ViewBox } from "./methods";
import type { HostApiV1 } from "../types";
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
    clear: async () => void rows.clear(),
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
  const caps = capabilityMethods({ moduleId: "m", view, light: createPageLight(doc, SURFACES), broker: createBroker(env), page: () => emptyPage, ...feeds, cache: createModuleCache(memoryCache()), account: () => 1, look, sheet: sheetOpen });
  const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": (el: unknown, host: HostApiV2) => (mount(el, host), () => {}) } };
  return { ...bootFrame({ capabilities, mod, methods: caps.methods }), props, caps };
}

describe("the frame's host API (bootstrap)", () => {
  it("tells the host the person's real gestures in the frame, over a port the module never gets", async () => {
    const ch = new MessageChannel();
    const told: unknown[] = [];
    ch.port1.onmessage = e => told.push(e.data);
    const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": () => () => {} } };
    const f = bootFrame({ capabilities: [], mod, methods: {}, own: ch.port2 });
    await settle();
    f.input("pointerdown", { isTrusted: true });
    // A script's own event is no gesture.
    f.input("pointerdown", { isTrusted: false });
    f.input("keydown", { isTrusted: true });
    await new Promise(r => setTimeout(r, 50));
    ch.port1.close();
    expect(told).toEqual(["pointer", "key"]);
  });

  it("tells the host its window took the focus (the page sees no move between frames), never as a gesture", async () => {
    const kinds: string[] = [];
    let focuses = 0;
    const own = ownReports(k => kinds.push(k), () => focuses++);
    const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": () => () => {} } };
    const f = bootFrame({ capabilities: [], mod, methods: {}, own: own.port });
    await settle();
    f.focus({ isTrusted: true });
    // A script's own focus event says nothing.
    f.focus({ isTrusted: false });
    await new Promise(r => setTimeout(r, 50));
    expect(focuses).toBe(1);
    expect(kinds).toEqual([]);
    // Not counted: a call after it waits for no report.
    expect(own.settle(0)).toBeNull();
    expect(own.settle(1)).not.toBeNull();
    own.close();
  });

  it("a click right after a pointer down reaches the host after its gesture (the port is slower than the window here)", async () => {
    let pointers = 0;
    const own = ownReports(kind => kind === "pointer" && pointers++);
    let host: HostApiV2 | null = null;
    const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": (_el: unknown, h: HostApiV2) => ((host = h), () => {}) } };
    const opened: number[] = [];
    const methods = {
      openSettings: method({
        args: z.tuple([]),
        rate: [1, 2],
        run() {
          if (pointers === 0) throw new Error("needs the person's gesture");
          opened.push(pointers);
        },
      }),
    };
    const f = bootFrame({ capabilities: [], mod, methods, own: own.port, settle: g => own.settle(g) });
    await settle();
    expect(host).not.toBeNull();
    f.input("pointerdown", { isTrusted: true });
    (host as HostApiV2 | null)?.openSettings?.();
    await new Promise(r => setTimeout(r, 50));
    own.close();
    expect(opened).toEqual([1]);
  });

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

  it("layoutChanged: every frame hears the page move, with no capability, until it lets go", async () => {
    let poke = () => {};
    let watching = 0;
    const lc = {
      feed: { poke: () => poke(), watch: (fn: () => void) => ((poke = fn), watching++, () => void watching--) },
      route: () => () => {},
    } as unknown as NonNullable<CapabilityDeps["layoutChanged"]>;
    const caps = capabilityMethods({ moduleId: "m", view: null, light: createPageLight(lightDoc().doc, SURFACES), broker: createBroker(quietEnv), page: () => emptyPage, ...feeds, cache: createModuleCache(memoryCache()), account: () => 1, look, sheet: sheetOpen, layoutChanged: lc });
    let heard = 0;
    let off = () => {};
    const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": (_el: unknown, host: HostApiV2) => ((off = host.layoutChanged?.(() => heard++) ?? off), () => {}) } };
    bootFrame({ capabilities: [], mod, methods: caps.methods });
    await settle();
    poke();
    poke();
    await settle();
    expect(heard).toBe(2);
    off();
    await settle();
    expect(watching).toBe(0);
  });

  it("layout.navFade: a module in the sidebar's foot has the host draw the nav's fade, while the nav has more below", async () => {
    let push: (v: LayoutState) => void = () => {};
    let watching = 0;
    const layout = { poke() {}, watch: (p: typeof push) => ((push = p), watching++, () => void watching--) } as unknown as CapabilityDeps["layout"];
    const el = { dataset: {} as Record<string, string>, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) } as unknown as HTMLElement;
    const caps = capabilityMethods({ moduleId: "m", view: { el, slot: "sidebar-footer", activate() {} }, light: createPageLight(lightDoc().doc, SURFACES), broker: createBroker(quietEnv), page: () => emptyPage, ...feeds, layout, cache: createModuleCache(memoryCache()), account: () => 1, look, sheet: sheetOpen });
    let fade: ((on: boolean) => void) | undefined;
    const mod = { id: "m", hostApi: 2, mount: { "sidebar-footer": (_el: unknown, host: HostApiV2) => ((fade = host.layout?.navFade), () => {}) } };
    bootFrame({ capabilities: ["layout"], mod, methods: caps.methods, slot: "sidebar-footer" });
    await settle();
    fade?.(true);
    await settle();
    push({ sidebar: "full", docked: false, navMore: true });
    expect("navFade" in el.dataset).toBe(true);
    push({ sidebar: "full", docked: false, navMore: false });
    expect("navFade" in el.dataset).toBe(false);
    push({ sidebar: "full", docked: false, navMore: true });
    fade?.(false);
    await settle();
    expect(["navFade" in el.dataset, watching]).toEqual([false, 0]);
    const other = capabilityMethods({ moduleId: "m", view: { el, slot: "mobile-more", activate() {} }, light: createPageLight(lightDoc().doc, SURFACES), broker: createBroker(quietEnv), page: () => emptyPage, ...feeds, cache: createModuleCache(memoryCache()), account: () => 1, look, sheet: sheetOpen });
    expect("layout.navFade" in other.methods).toBe(false);
  });

  it("more.close: only a row of the phone's More sheet may close it", async () => {
    let closed = 0;
    const offered: boolean[] = [];
    for (const slot of ["mobile-more", "sidebar-footer"]) {
      const el = { dataset: {}, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) } as unknown as HTMLElement;
      const caps = capabilityMethods({ moduleId: "m", view: { el, slot, activate() {} }, light: createPageLight(lightDoc().doc, SURFACES), broker: createBroker(quietEnv), page: () => emptyPage, ...feeds, cache: createModuleCache(memoryCache()), account: () => 1, look, sheet: sheetOpen, more: { close: () => void closed++ } });
      const mod = { id: "m", hostApi: 2, mount: { [slot]: (_el: unknown, host: HostApiV2) => (offered.push(host.more !== undefined), host.more?.close(), () => {}) } };
      bootFrame({ capabilities: [], mod, methods: caps.methods, slot });
      await settle();
      expect("more.close" in caps.methods).toBe(slot === "mobile-more");
    }
    expect(offered).toEqual([true, false]);
    expect(closed).toBe(1);
  });

  it("the document going (its box removed with it) still runs the view's cleanup, once, and says so", async () => {
    let cleaned = 0;
    let unmounted = 0;
    const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": () => () => void cleaned++ } };
    const f = bootFrame({ capabilities: [], mod, methods: {}, onUnmounted: () => void unmounted++ });
    await settle();
    f.pagehide();
    f.pagehide();
    await settle();
    expect([cleaned, unmounted]).toEqual([1, 1]);
  });

  it("page.importance: the box's points, off the box counting as important", async () => {
    const el = { dataset: {}, getBoundingClientRect: () => ({ left: 90, top: 0, width: 20, height: 20 }) } as unknown as HTMLElement;
    let out: unknown = null;
    withModule(["page.importance"], (_el, host) => void host.page?.importance([[5, 5], [20, 5]]).then(r => (out = r)), quietEnv, { el, slot: "panel-edge", activate() {} });
    await settle();
    expect(out).toEqual([0, 1]);
  });

  it("page.ledges: the cards' top edges in the box's px, only with its capability", async () => {
    const el = { dataset: {}, getBoundingClientRect: () => ({ left: 100, top: 40, width: 800, height: 600 }) } as unknown as HTMLElement;
    const card = { getBoundingClientRect: () => ({ left: 150, top: 200, right: 550, bottom: 400 }), contains: (n: Node | null) => n === hitNode };
    const hitNode = {} as Node;
    const ledges = () => ({ candidates: () => [card], elementFromPoint: () => hitNode, clear: () => true, width: 1200, height: 800 });
    const run = async (capabilities: ModuleCapability[]) => {
      let out: unknown = "none";
      const caps = capabilityMethods({ moduleId: "m", view: { el, slot: "dashboard-overlay", activate() {} }, light: createPageLight(lightDoc().doc, SURFACES), broker: createBroker(quietEnv), page: () => emptyPage, ledges, ...feeds, cache: createModuleCache(memoryCache()), account: () => 1, look, sheet: sheetOpen });
      const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": (_el: unknown, host: HostApiV2) => (void host.ledges?.().then(r => (out = r)), () => {}) } };
      bootFrame({ capabilities, mod, methods: caps.methods });
      await settle();
      return out;
    };
    expect(await run(["page.ledges"])).toEqual([{ x: 50, y: 160, w: 400 }]);
    expect(await run([])).toBe("none");
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
    const methods = { "hit.set": method({ args: z.tuple([z.unknown(), z.unknown()]), rate: [10, 10], run: ([m]) => void got.push(m) }) };
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
    const methods = capabilityMethods({ moduleId: "m", view: null, light: createPageLight(doc, SURFACES), broker: createBroker(quietEnv), page: () => emptyPage, ...feeds, cache: createModuleCache(memoryCache()), account: () => 1, look, sheet: sheetOpen }).methods;
    const mod = { id: "m", hostApi: 2, mount: { sheet: () => () => {} } };
    const frame = bootFrame({ capabilities: caps, mod, methods, slot: "sheet" });
    await settle();
    frame.keydown("Escape");
    await settle();
    expect(sheetOpen.get()).toBeNull();
  });

  it("sheet: closed, the focus the host gives back to the frame goes on to the control that opened it", async () => {
    sheetOpen.close();
    let focused = 0;
    const card = { isConnected: true, focus: () => void focused++ };
    let open = () => {};
    const f = withModule(["sheet"], (_el, host) => void (open = () => host.sheet?.open()));
    await settle();
    f.setActive(card);
    open();
    await settle();
    expect(sheetOpen.get()).toBe("m");
    // The frame lost the focus to the sheet; the host focuses this iframe again as it closes.
    sheetOpen.close();
    f.setActive(f.body);
    f.focus();
    expect(focused).toBe(1);
    // Once: a later return to the frame (a click, a Tab) is the person's own.
    f.focus();
    expect(focused).toBe(1);
    // Focus already on a control as the frame gets it back: left there.
    f.setActive(card);
    open();
    await settle();
    sheetOpen.close();
    f.setActive({ isConnected: true, focus() {} });
    f.focus();
    expect(focused).toBe(1);
  });

  it("sheet: the opening view's box is kept, once, for the focus to go back to", async () => {
    sheetOpen.close();
    const el = { dataset: {}, isConnected: true, getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0 }) } as unknown as HTMLElement;
    withModule(["sheet"], (_el, host) => host.sheet?.open(), quietEnv, { el, slot: "sidebar-rail", activate() {} });
    await settle();
    expect(sheetOpen.get()).toBe("m");
    expect(sheetOpen.takeOpener()).toBe(el);
    expect(sheetOpen.takeOpener()).toBeNull();
    sheetOpen.close();
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

  it("hit areas: the module hears how it was activated, and its host box's focus", async () => {
    const heard: unknown[] = [];
    const methods = { "hit.set": method({ args: z.tuple([z.unknown(), z.unknown()]), rate: [10, 10], run: () => {} }) };
    const mod = {
      id: "m",
      hostApi: 2,
      mount: {
        "dashboard-overlay": (_el: unknown, host: HostApiV2) => {
          host.hit.set([{ kind: "rect", x: 0, y: 0, w: 1, h: 1 }], how => heard.push(how), { focusable: true, onFocus: (f, v) => heard.push([f, v]) });
          return () => {};
        },
      },
    };
    const f = bootFrame({ capabilities: [], mod, methods, slot: "dashboard-overlay" });
    await settle();
    f.peer.send({ v: RPC_VERSION, t: "hit-focus", focused: true, visible: true });
    f.peer.send({ v: RPC_VERSION, t: "activate", how: { via: "keyboard" } });
    f.peer.send({ v: RPC_VERSION, t: "activate", how: { via: "pointer", x: 3, y: 4 } });
    f.peer.send({ v: RPC_VERSION, t: "hit-focus", focused: false, visible: false });
    await settle();
    expect(heard).toEqual([[true, true], { via: "keyboard" }, { via: "pointer", x: 3, y: 4 }, [false, false]]);
  });

  it("a frame with room past its box (the dock's shadow): the module's box keeps the slot's size", async () => {
    const mod = { id: "m", hostApi: 2, mount: { "mobile-dock": () => () => {} } };
    const f = bootFrame({ capabilities: [], mod, methods: {}, slot: "mobile-dock", room: { top: 16, right: 8, bottom: 16, left: 16 } });
    await settle();
    expect(f.box.style).toEqual({ top: "16px", right: "8px", bottom: "16px", left: "16px" });
  });

  it("hit shapes set faster than ten a second: the latest is the one the host gets", async () => {
    const got: unknown[] = [];
    const methods = { "hit.set": method({ args: z.tuple([z.unknown(), z.unknown()]), rate: [10, 10], run: ([m]) => void got.push(m) }) };
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

describe("storage writes from a frame", () => {
  // The host's own methods (its rates), over a store that counts the writes reaching it.
  function store() {
    const rows = new Map<string, { value: unknown; revision: number }>();
    const calls = { set: 0, setIf: 0 };
    const cas: Cas = {
      read: async k => rows.get(k) ?? { value: undefined, revision: 0 },
      async setIf(k, value, ifRevision) {
        calls.setIf++;
        const now = rows.get(k) ?? { value: undefined, revision: 0 };
        if (now.revision !== ifRevision) return { conflict: true, ...now };
        rows.set(k, { value, revision: now.revision + 1 });
        return { revision: now.revision + 1 };
      },
    };
    const api = {
      storage: {
        get: async (k: string) => rows.get(k)?.value,
        async set(k: string, value: unknown) {
          calls.set++;
          rows.set(k, { value, revision: (rows.get(k)?.revision ?? 0) + 1 });
        },
        delete: async (k: string) => void rows.delete(k),
      },
    } as unknown as HostApiV1;
    return { rows, calls, methods: frameMethods(api, cas, null).methods };
  }
  const run = (methods: ReturnType<typeof store>["methods"], body: (host: HostApiV2) => void) => {
    const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": (_el: unknown, host: HostApiV2) => (body(host), () => {}) } };
    return bootFrame({ capabilities: [], mod, methods });
  };

  it("a burst of updates on one key coalesces: every change applied, in order, none refused", async () => {
    const s = store();
    const results: unknown[] = [];
    run(s.methods, host => {
      for (let i = 0; i < 40; i++) void host.storage.update<number>("n", n => (n ?? 0) + 1).then(v => results.push(v), (e: Error) => results.push(e.message));
    });
    await settle(30);
    expect(results).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(s.rows.get("n")?.value).toBe(40);
    expect(s.calls.setIf).toBeLessThanOrEqual(4);
  });

  it("a burst of sets on one key: the latest wins, every caller answered", async () => {
    const s = store();
    let done = 0;
    run(s.methods, host => {
      for (let i = 0; i < 40; i++) void host.storage.set("k", i).then(() => void done++);
    });
    await settle(30);
    expect(done).toBe(40);
    expect(s.rows.get("k")?.value).toBe(39);
    expect(s.calls.set).toBeLessThanOrEqual(2);
  });

  it("reads for updates of many keys keep the host's pace too (more than its burst, none refused)", async () => {
    const s = store();
    const errors: string[] = [];
    run(s.methods, host => {
      // A change that refuses: a read each, no write.
      for (let i = 0; i < 36; i++)
        void host.storage.update("r" + i, () => {
          throw new Error("kept");
        }).catch((e: Error) => errors.push(e.message));
    });
    await new Promise(r => setTimeout(r, 1200));
    await settle(10);
    expect(errors).toEqual(Array.from({ length: 36 }, () => "kept"));
  });

  it("writes to many keys wait their turn at the host's pace instead of being refused", async () => {
    const s = store();
    const errors: string[] = [];
    let done = 0;
    run(s.methods, host => {
      for (let i = 0; i < 20; i++) void host.storage.update<number>("k" + i, () => i).then(() => void done++, (e: Error) => errors.push(e.message));
    });
    await new Promise(r => setTimeout(r, 1800));
    await settle(10);
    expect(errors).toEqual([]);
    expect(done).toBe(20);
  });
});

describe("cleanups that save", () => {
  const timeline = () => {
    const t0 = Date.now();
    const log: [string, number][] = [];
    return { log, mark: (what: string) => log.push([what, Date.now() - t0]) };
  };

  it("a view's cleanup promise is waited for: the host hears it is done only once it settles", async () => {
    const { log, mark } = timeline();
    const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": () => () => new Promise<void>(r => setTimeout(() => (mark("saved"), r()), 60)) } };
    const f = bootFrame({ capabilities: [], mod, methods: {}, onUnmounted: () => mark("unmounted") });
    await settle();
    f.peer.send({ v: RPC_VERSION, t: "unmount" });
    await new Promise(r => setTimeout(r, 300));
    expect(log.map(([w]) => w)).toEqual(["saved", "unmounted"]);
  });

  it("a cleanup promise that never settles holds the frame about a second, no more", async () => {
    const { log, mark } = timeline();
    const mod = { id: "m", hostApi: 2, mount: { "dashboard-widget": () => () => new Promise<void>(() => {}) } };
    const f = bootFrame({ capabilities: [], mod, methods: {}, onUnmounted: () => mark("unmounted") });
    await settle();
    f.peer.send({ v: RPC_VERSION, t: "unmount" });
    await new Promise(r => setTimeout(r, 600));
    expect(log).toEqual([]);
    await new Promise(r => setTimeout(r, 900));
    expect(log.map(([w]) => w)).toEqual(["unmounted"]);
  });

  it("the runtime's cleanup runs when the host closes it, and on pagehide, once", async () => {
    const order: string[] = [];
    const runtime = () => () => new Promise<void>(r => setTimeout(() => (order.push("flushed"), r()), 20));
    const mod = { id: "m", hostApi: 2, runtime, mount: {} };
    const f = bootFrame({ capabilities: ["runtime"], mod, methods: {}, role: "runtime", onUnmounted: () => order.push("unmounted") });
    await settle();
    f.peer.send({ v: RPC_VERSION, t: "unmount" });
    await new Promise(r => setTimeout(r, 200));
    expect(order).toEqual(["flushed", "unmounted"]);

    let ran = 0;
    const g = bootFrame({ capabilities: ["runtime"], mod: { id: "m", hostApi: 2, runtime: () => () => void ran++, mount: {} }, methods: {}, role: "runtime" });
    await settle();
    g.pagehide();
    g.pagehide();
    await settle();
    expect(ran).toBe(1);
  });
});

describe("the frame's beat", () => {
  const hogged = async (globals: Record<string, unknown>) => {
    let clock = 0;
    let beat = () => {};
    const busy: number[] = [];
    const f = bootFrame({
      capabilities: [],
      mod: { id: "m", hostApi: 2, mount: { "dashboard-widget": () => () => {} } },
      methods: {},
      onBeat: b => busy.push(b),
      globals: {
        performance: { now: () => clock },
        setInterval: (fn: () => void, ms: number) => ((ms === 500 ? (beat = fn) : null), 0),
        ...globals,
      },
    });
    await settle();
    // The module's own timers: one 300 ms loop, one quick callback.
    f.win.setTimeout(() => void (clock += 300));
    f.win.setTimeout(() => void (clock += 10));
    await settle();
    beat();
    await settle();
    return busy;
  };

  it("without long-task data (WebKit, frames on the page's thread) a frame counts its own long callbacks", async () => {
    expect(await hogged({})).toEqual([300]);
  });

  it("where long tasks are reported (Chrome) they alone count: the timers are left as they are", async () => {
    class PerformanceObserver {
      static supportedEntryTypes = ["longtask"];
      observe() {}
    }
    expect(await hogged({ PerformanceObserver })).toEqual([0]);
  });
});
