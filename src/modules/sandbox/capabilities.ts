import { z } from "zod";
import { method, RPC_MAX_BYTES, type Method, type MethodContext } from "./rpc";

export const PICTURE_MAX_BYTES = RPC_MAX_BYTES - 64 * 1024;
import type { ViewBox } from "./methods";
import { parseLight, type createPageLight } from "./light";
import type { createBroker } from "./broker";
import { IMPORTANCE_MAX_POINTS, importanceAround, type ImportancePage } from "./importance";
import type { createLayoutFeed, createPointerFeed } from "./feeds";
import type { createModuleCache } from "./cache";

/**
 * The host API members a framed module gets only with their capability
 * (each method names it: the peer refuses it otherwise). What one leaves on
 * the page goes when its frame goes.
 */

export type CapabilityDeps = {
  moduleId: string;
  /** Where the view draws; null for the runtime frame. */
  view: ViewBox | null;
  light: ReturnType<typeof createPageLight>;
  broker: ReturnType<typeof createBroker>;
  /** The page as it is now (read per call: its size changes). */
  page: () => ImportancePage;
  pointer: ReturnType<typeof createPointerFeed>;
  layout: ReturnType<typeof createLayoutFeed>;
  /** Watches the blur wanted over a backdrop box. */
  blur(box: Element, push: (px: number) => void): () => void;
  cache: ReturnType<typeof createModuleCache>;
};

const subId = z.number().int().min(1).max(2 ** 31);
const MAX_WATCHES = 16;

/** A picture over messages: under the message cap, with room for the rest of the call. */
const picture = z.instanceof(Blob).refine(b => b.size > 0 && b.size <= PICTURE_MAX_BYTES);
const fileName = z.string().max(200);
const cacheKey = z.string().min(1).max(128);

export function capabilityMethods(d: CapabilityDeps): { methods: Record<string, Method>; dispose(): void } {
  // This frame, as owner of what it set (the light).
  const token = {};
  const watches = new Map<number, () => void>();
  const watch = (start: (push: (v: unknown) => void) => () => void) => ({
    args: z.tuple([subId]),
    rate: [4, 8] as const,
    run([id]: [number], ctx: MethodContext) {
      if (watches.size >= MAX_WATCHES && !watches.has(id)) throw new Error("too many watches");
      watches.get(id)?.();
      watches.set(id, ctx.own(start(v => ctx.push(id, v))));
    },
  });
  const methods: Record<string, Method> = {
    unwatch: method({
      args: z.tuple([subId]),
      rate: [8, 16],
      run([id]) {
        watches.get(id)?.();
        watches.delete(id);
      },
    }),
    layout: method({ ...watch(push => d.layout.watch(push)), cap: "layout" }),
    "cache.get": method({ args: z.tuple([cacheKey]), cap: "cache", rate: [10, 30], run: ([k]) => d.cache.get(d.moduleId, k) }),
    "cache.put": method({ args: z.tuple([cacheKey, z.instanceof(Blob).refine(b => b.size <= PICTURE_MAX_BYTES)]), cap: "cache", rate: [4, 16], run: ([k, b]) => d.cache.put(d.moduleId, k, b) }),
    "cache.delete": method({ args: z.tuple([cacheKey]), cap: "cache", rate: [4, 16], run: ([k]) => d.cache.delete(d.moduleId, k) }),
    "surfaces.light": method({
      args: z.tuple([z.union([z.null(), z.record(z.string().max(32), z.unknown()).refine(v => Object.keys(v).length <= 8)])]),
      cap: "surfaces.light",
      rate: [2, 6],
      run([vars]) {
        if (vars === null) return void d.light.set(d.moduleId, token, null);
        const parsed = parseLight(vars);
        if (!parsed.ok) throw new Error(`light: ${parsed.name} refused`);
        if (!d.light.set(d.moduleId, token, parsed.light)) throw new Error("light: another module casts it");
      },
    }),
    share: method({ args: z.tuple([picture, fileName]), cap: "share", rate: [1, 2], run: ([f, name]) => d.broker.share(f, name) }),
    download: method({ args: z.tuple([picture, fileName]), cap: "download", rate: [1, 3], run: ([f, name]) => d.broker.download(f, name) }),
    openImage: method({ args: z.tuple([picture]), cap: "open-image", rate: [1, 2], run: ([f]) => d.broker.openImage(f) }),
    "geo.here": method({ args: z.tuple([]), cap: "geo", rate: [0.2, 2], run: () => d.broker.here() }),
  };
  const view = d.view;
  if (view) {
    // Box-bound: the frame knows only its own box, the host adds where it is.
    methods["page.importance"] = method({
      args: z.tuple([z.array(z.tuple([z.number().finite(), z.number().finite()])).max(IMPORTANCE_MAX_POINTS)]),
      cap: "page.importance",
      rate: [4, 4],
      run([points]) {
        const r = view.el.getBoundingClientRect();
        return importanceAround(d.page(), r.left, r.top, points);
      },
    });
    methods.pointer = method({ ...watch(push => d.pointer.watch(() => view.el.getBoundingClientRect(), push)), cap: "pointer" });
    methods["backdrop.blur"] = method({ ...watch(push => d.blur(view.el, push)), cap: "backdrop.preblurred" });
  }
  return {
    methods,
    dispose() {
      watches.forEach(off => off());
      watches.clear();
      d.light.release(token);
    },
  };
}
