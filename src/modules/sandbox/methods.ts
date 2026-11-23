import { z } from "zod";
import { FILE_MAX_BYTES } from "@contracts/modules";
import { hitAreas, type HitTest } from "../hit";
import type { BudgetLevel, HitActivation, HitDrag, HitRegion } from "../hostV2";
import type { HostApiV1, HostEventName } from "../types";
import { method, type Method, type MethodContext } from "./rpc";
import { SESSION_KEY_MAX, SESSION_VALUE_MAX, type SessionStore } from "./session";

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

/**
 * Drawn over the page: the frame never takes pointer events there, the host tests its regions.
 * The dock too, once it sets a shape (its box marked data-hit): taps around the pill reach the page.
 */
const OVERLAYS: readonly string[] = ["dashboard-overlay", "dashboard-perch", "panel-edge", "mobile-dock", "page-overlay"];
/**
 * Boxes over the whole page or the whole Desk: never a button of the host's, whatever the module asks
 * (a Tab stop the size of the window, every small control beside it crowded: WCAG 2.5.8).
 */
const NO_TAB_STOP: readonly string[] = ["dashboard-overlay", "page-overlay"];

const subId = z.number().int().min(1).max(2 ** 31);
const key = z.string().min(1).max(128);
const sessionKey = z.string().min(1).max(SESSION_KEY_MAX);
const num = z.number().finite();
const hitOptions = z.object({ label: z.string().max(120).optional(), focusable: z.boolean().optional(), drag: z.boolean().optional() }).strict();
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

/**
 * The most of its box a shape may take (CSS px², or a share of a large box): a creature or a pill,
 * never a catch-all over the page that would swallow every click there.
 */
const HIT_MAX_PX2 = 256 * 256;
const HIT_MAX_SHARE = 0.25;

/** The area (CSS px²) regions cover in a box of w × h, overlaps counted twice. */
const regionsArea = (regions: readonly HitRegion[], w: number, h: number) =>
  regions.reduce((sum, r) => {
    const [x0, y0, x1, y1] = r.kind === "rect" ? [r.x, r.y, r.x + r.w, r.y + r.h] : [r.x - r.r, r.y - r.r, r.x + r.r, r.y + r.r];
    const clipped = Math.max(0, Math.min(w, x1) - Math.max(0, x0)) * Math.max(0, Math.min(h, y1) - Math.max(0, y0));
    return sum + (r.kind === "rect" ? clipped : Math.min(clipped, Math.PI * r.r ** 2));
  }, 0);

const tooLarge = (area: number, w: number, h: number) => area > Math.max(HIT_MAX_PX2, HIT_MAX_SHARE * w * h);

const inRegion = (r: HitRegion, x: number, y: number) =>
  r.kind === "rect" ? x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h : (x - r.x) ** 2 + (y - r.y) ** 2 <= r.r ** 2;

export type Cas = {
  read(key: string): Promise<{ value: unknown; revision: number }>;
  setIf(key: string, value: unknown, ifRevision: number): Promise<{ revision: number } | { conflict: true; value: unknown; revision: number }>;
};

/** Where a view draws, for what touches its box (hit regions, dock, preblurred); none for the runtime. `hits`: the page's hit areas. */
export type ViewBox = {
  el: HTMLElement;
  slot: string;
  activate: (how?: HitActivation) => void;
  /** Its host box took or lost the focus (`visible`: the keyboard's). */
  focus?: (focused: boolean, visible: boolean) => void;
  onDock?: () => void;
  hits?: Pick<ReturnType<typeof hitAreas>, "add">;
  /** "drag" declared: its shape carried, told to the frame. */
  drag?: (d: HitDrag) => void;
};

/**
 * The host API a framed module reaches over messages, from the same hub API
 * an in-page module gets (its guards, and its stop when the module goes).
 */
export function frameMethods(
  api: HostApiV1,
  cas: Cas,
  view: ViewBox | null,
  budget: (fn: (b: BudgetLevel) => void) => () => void = fn => (fn("normal"), () => {}),
  session: { moduleId: string; store: SessionStore } | null = null,
  /** Whether the person's latest gesture was in this frame's own view (never, for a runtime). */
  gesture: () => boolean = () => false,
): { methods: Record<string, Method>; dispose(): void } {
  const subs = new Map<number, () => void>();
  const subscribe = (id: number, ctx: MethodContext, off: () => void) => {
    subs.get(id)?.();
    subs.set(id, ctx.own(off));
  };
  let unhit: (() => void) | null = null;
  // The shape now: a new one replaces it in place (the box keeps its focus and name).
  let shapeTest: HitTest | null = null;
  let hitA11y = "";
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
        else subscribe(id, ctx, budget(push));
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
    totals: method({ args: z.tuple([]), rate: [2, 5], shared: true, run: () => api.totals() }),
    "history.daily": method({
      args: z.union([z.tuple([]), z.tuple([num])]),
      rate: [1, 3],
      shared: true,
      run: a => api.history?.daily(a[0]) ?? [],
    }),
    weather: method({
      args: z.tuple([z.object({ lat: num.min(-90).max(90), lon: num.min(-180).max(180) }).strict()]),
      rate: [1, 3],
      shared: true,
      run: ([at]) => api.weather(at),
    }),
    geocode: method({ args: z.tuple([z.string().max(100)]), rate: [2, 4], shared: true, run: ([q]) => api.geocode(q) }),
    // A dialog over the app: only on the person's gesture in this module's view, never by itself.
    openSettings: method({
      args: z.tuple([]),
      rate: [1, 2],
      run() {
        if (!gesture()) throw new Error("needs the person's gesture");
        api.openSettings?.();
      },
    }),
    "files.get": method({ args: z.tuple([key]), rate: [4, 16], shared: true, run: ([k]) => api.files?.get(k) ?? null }),
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
    "session.get": method({ args: z.tuple([sessionKey]), rate: [10, 30], run: ([k]) => session?.store.get(session.moduleId, k) ?? null }),
    "session.set": method({
      args: z.tuple([sessionKey, z.string().max(SESSION_VALUE_MAX)]),
      rate: [4, 16],
      run: ([k, v]) => session?.store.set(session.moduleId, k, v),
    }),
    "session.delete": method({ args: z.tuple([sessionKey]), rate: [4, 16], run: ([k]) => session?.store.delete(session.moduleId, k) }),
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
    if (view) delete view.el.dataset.hit;
    unhit?.();
    unhit = null;
    shapeTest = null;
    hitA11y = "";
  };
  if (!view) return { methods, dispose };
  const box = view.el;
  return {
    dispose,
    methods: {
      ...methods,
      "hit.set": method({
        args: z.union([z.tuple([z.array(region).max(32)]), z.tuple([mask]), z.tuple([z.union([z.array(region).max(32), mask]), hitOptions])]),
        rate: [10, 10],
        run([shape, opts]) {
          if (!OVERLAYS.includes(view.slot)) return dispose();
          // Judged against the box as it is at each test (it may grow after the shape is set).
          let test: HitTest | null = null;
          if (!Array.isArray(shape)) {
            let solid = 0;
            for (const a of shape.alpha) if (a >= MASK_SOLID) solid++;
            const share = solid / shape.alpha.length;
            test = (x, y, w, h) => !tooLarge(share * w * h, w, h) && onMask(shape, x, y, w, h);
          } else if (shape.length > 0) {
            const regions: readonly HitRegion[] = shape;
            test = (x, y, w, h) => !tooLarge(regionsArea(regions, w, h), w, h) && regions.some(r => inRegion(r, x, y));
          }
          if (!test) return dispose();
          // No Tab stop of the host's own unless asked: the frame's control takes the keyboard.
          const a11y = NO_TAB_STOP.includes(view.slot) ? { focusable: false, label: undefined } : { focusable: opts?.focusable === true, label: opts?.label };
          // Carried only when it asks and declared "drag".
          const drag = opts?.drag === true ? view.drag : undefined;
          const key = JSON.stringify({ ...a11y, drag: !!drag });
          shapeTest = test;
          box.dataset.hit = "";
          if (unhit && key === hitA11y) return;
          unhit?.();
          hitA11y = key;
          unhit = (view.hits ?? hitAreas()).add(box, (x, y, w, h) => shapeTest?.(x, y, w, h) ?? false, view.activate, { ...a11y, onFocus: view.focus }, drag);
        },
      }),
      // A card with nothing to show leaves the Desk, as an in-page module's hidden box does.
      "box.hidden": method({
        args: z.tuple([z.boolean()]),
        rate: [4, 8],
        run([on]) {
          if (view.slot === "dashboard-widget") box.hidden = on;
        },
      }),
      "dock.set": method({
        args: z.tuple([z.boolean()]),
        cap: "dock",
        rate: [4, 8],
        run([on]) {
          if (on) box.dataset.docked = "";
          else delete box.dataset.docked;
          view.onDock?.();
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
