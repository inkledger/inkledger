import { z } from "zod";
import { method, RPC_MAX_BYTES, type Method } from "./rpc";

export const PICTURE_MAX_BYTES = RPC_MAX_BYTES - 64 * 1024;
import type { ViewBox } from "./methods";
import { parseLight, type createPageLight } from "./light";
import type { createBroker } from "./broker";

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
};

/** A picture over messages: under the message cap, with room for the rest of the call. */
const picture = z.instanceof(Blob).refine(b => b.size > 0 && b.size <= PICTURE_MAX_BYTES);
const fileName = z.string().max(200);

export function capabilityMethods(d: CapabilityDeps): { methods: Record<string, Method>; dispose(): void } {
  // This frame, as owner of what it set (the light).
  const token = {};
  const methods: Record<string, Method> = {
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
  return {
    methods,
    dispose() {
      d.light.release(token);
    },
  };
}
