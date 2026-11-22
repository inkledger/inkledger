import { z } from "zod";
import { method, type Method } from "./rpc";
import type { ViewBox } from "./methods";
import { parseLight, type createPageLight } from "./light";

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
};

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
  };
  return {
    methods,
    dispose() {
      d.light.release(token);
    },
  };
}
