import { z } from "zod";
import { FILE_MAX_BYTES } from "@contracts/modules";
import { hitAreas } from "../hit";
import type { HitRegion } from "../hostV2";
import type { HostApiV1, HostEventName } from "../types";
import { method, type Method, type MethodContext } from "./rpc";

/** Every host event a framed module may hear. */
const EVENTS = [
  "timer-started",
  "timer-stopped",
  "issue-moved",
  "issue-closed",
  "worklog-logged",
  "worklog-changed",
  "goal-reached",
  "focus-mode",
  "screensaver",
  "route",
] as const satisfies readonly HostEventName[];
// A new host event fails here until it is listed above.
const allEvents: Exclude<HostEventName, (typeof EVENTS)[number]> extends never ? true : never = true;
void allEvents;

/** Drawn over the page: the frame never takes pointer events there, the host tests its regions. */
const OVERLAYS: readonly string[] = ["dashboard-overlay", "dashboard-perch"];

const subId = z.number().int().min(1).max(2 ** 31);
const key = z.string().min(1).max(128);
const num = z.number().finite();
const region = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rect"), x: num, y: num, w: num.min(0), h: num.min(0) }).strict(),
  z.object({ kind: z.literal("circle"), x: num, y: num, r: num.min(0) }).strict(),
]);

/** An overlay's shape as an alpha mask over its box (the frame scales its picture down to this). */
export const MASK_MAX_SIDE = 512;
const side = z.number().int().min(1).max(MASK_MAX_SIDE);
const mask = z
  .object({ kind: z.literal("mask"), w: side, h: side, alpha: z.instanceof(Uint8Array) })
  .strict()
  .refine(m => m.alpha.length === m.w * m.h);
/** Alpha at or over this is the shape (antialiased edges below it let the page keep the click). */
const MASK_SOLID = 32;

/** Whether a point of a box (w × h) is on the mask stretched over it. */
export const onMask = (m: { w: number; h: number; alpha: Uint8Array }, x: number, y: number, w: number, h: number) => {
  if (w <= 0 || h <= 0) return false;
  const mx = Math.min(m.w - 1, Math.floor((x / w) * m.w));
  const my = Math.min(m.h - 1, Math.floor((y / h) * m.h));
  return mx >= 0 && my >= 0 && (m.alpha[my * m.w + mx] ?? 0) >= MASK_SOLID;
};

const inRegion = (r: HitRegion, x: number, y: number) =>
  r.kind === "rect" ? x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h : (x - r.x) ** 2 + (y - r.y) ** 2 <= r.r ** 2;

export type Cas = {
  read(key: string): Promise<{ value: unknown; revision: number }>;
  setIf(key: string, value: unknown, ifRevision: number): Promise<{ revision: number } | { conflict: true; value: unknown; revision: number }>;
};

/** Where a view draws, for what touches its box (hit regions, dock, preblurred); none for the runtime. */
export type ViewBox = { el: HTMLElement; slot: string; activate: () => void };

/**
 * The host API a framed module reaches over messages, from the same hub API
 * an in-page module gets (its guards, and its stop when the module goes).
 */
export function frameMethods(api: HostApiV1, cas: Cas, view: ViewBox | null): { methods: Record<string, Method>; dispose(): void } {
  const subs = new Map<number, () => void>();
  const subscribe = (id: number, ctx: MethodContext, off: () => void) => {
    subs.get(id)?.();
    subs.set(id, ctx.own(off));
  };
  let unhit: (() => void) | null = null;
  const methods: Record<string, Method> = {
    sub: method({
      args: z.union([
        z.tuple([subId, z.enum(["timer", "today", "theme", "budget"])]),
        z.tuple([subId, z.literal("event"), z.enum(EVENTS)]),
      ]),
      rate: [20, 40],
      run(a, ctx) {
        const id = a[0];
        if (subs.size >= 64 && !subs.has(id)) throw new Error("too many subscriptions");
        const push = (v: unknown) => ctx.push(id, v);
        if (a[1] === "event") subscribe(id, ctx, api.on(a[2], push));
        else if (a[1] === "timer") subscribe(id, ctx, api.timer(push));
        else if (a[1] === "today") subscribe(id, ctx, api.today(push));
        else if (a[1] === "theme") subscribe(id, ctx, api.theme(push));
        else {
          // TODO(sandbox phase 3): the watchdog's ladder sets "reduce" and "still".
          push("normal");
          subscribe(id, ctx, () => {});
        }
      },
    }),
    unsub: method({
      args: z.tuple([subId]),
      rate: [20, 40],
      run([id]) {
        subs.get(id)?.();
        subs.delete(id);
      },
    }),
    totals: method({ args: z.tuple([]), rate: [2, 5], run: () => api.totals() }),
    "history.daily": method({
      args: z.union([z.tuple([]), z.tuple([num])]),
      rate: [1, 3],
      run: a => api.history?.daily(a[0]) ?? [],
    }),
    weather: method({
      args: z.tuple([z.object({ lat: num.min(-90).max(90), lon: num.min(-180).max(180) }).strict()]),
      rate: [1, 3],
      run: ([at]) => api.weather(at),
    }),
    geocode: method({ args: z.tuple([z.string().max(100)]), rate: [2, 4], run: ([q]) => api.geocode(q) }),
    openSettings: method({ args: z.tuple([]), rate: [1, 2], run: () => api.openSettings?.() }),
    "files.get": method({ args: z.tuple([key]), rate: [4, 16], run: ([k]) => api.files?.get(k) ?? null }),
    "files.put": method({
      args: z.tuple([key, z.instanceof(Blob).refine(b => b.size <= FILE_MAX_BYTES)]),
      rate: [1, 4],
      run: ([k, b]) => api.files?.put(k, b),
    }),
    "files.delete": method({ args: z.tuple([key]), rate: [2, 8], run: ([k]) => api.files?.delete(k) }),
    "storage.get": method({ args: z.tuple([key]), rate: [10, 30], run: ([k]) => api.storage.get(k) }),
    "storage.set": method({ args: z.tuple([key, z.unknown()]), rate: [4, 16], run: ([k, v]) => api.storage.set(k, v) }),
    "storage.delete": method({ args: z.tuple([key]), rate: [4, 16], run: ([k]) => api.storage.delete(k) }),
    "storage.read": method({ args: z.tuple([key]), rate: [10, 30], run: ([k]) => cas.read(k) }),
    "storage.setIf": method({
      args: z.tuple([key, z.unknown(), z.number().int().min(0)]),
      rate: [4, 16],
      async run([k, v, rev]) {
        const r = await cas.setIf(k, v, rev);
        return "conflict" in r ? { ok: false, value: r.value, revision: r.revision } : { ok: true };
      },
    }),
  };
  const dispose = () => {
    unhit?.();
    unhit = null;
  };
  if (!view) return { methods, dispose };
  const box = view.el;
  return {
    dispose,
    methods: {
      ...methods,
      "hit.set": method({
        args: z.union([z.tuple([z.array(region).max(32)]), z.tuple([mask])]),
        rate: [10, 10],
        run([shape]) {
          dispose();
          if (!OVERLAYS.includes(view.slot)) return;
          if (!Array.isArray(shape)) {
            unhit = hitAreas().add(box, (x, y, w, h) => onMask(shape, x, y, w, h), view.activate);
            return;
          }
          const regions: readonly HitRegion[] = shape;
          if (regions.length === 0) return;
          unhit = hitAreas().add(box, (x, y) => regions.some(r => inRegion(r, x, y)), view.activate);
        },
      }),
      "dock.set": method({
        args: z.tuple([z.boolean()]),
        cap: "dock",
        rate: [4, 8],
        run([on]) {
          if (on) box.dataset.docked = "";
          else delete box.dataset.docked;
        },
      }),
      "backdrop.preblurred": method({
        args: z.tuple([z.boolean()]),
        cap: "backdrop.preblurred",
        rate: [2, 4],
        run([on]) {
          if (on) box.dataset.preblurred = "";
          else delete box.dataset.preblurred;
        },
      }),
    },
  };
}
