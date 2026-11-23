import { z } from "zod";
import { DOWNLOAD_LARGE_MAX_BYTES, PICTURE_MAX_BYTES, type ModuleCapability } from "@contracts/modules";
import type { HitActivation, HitDrag } from "../hostV2";

/**
 * The host's end of a framed module's messages. A sandboxed frame has an
 * opaque origin ("null"), so what proves a message is the frame's is its
 * source: only `event.source === iframe.contentWindow` is read. Every message
 * is size-capped before it is parsed, schema-checked, and every call is held
 * to the module's signed capabilities and a rate per method. Nothing is
 * synchronous: a call is answered by a later message.
 */

export const RPC_VERSION = 1;
/** Estimated bytes of one message (strings, binary, blobs, bitmaps); more is dropped unread. */
export const RPC_MAX_BYTES = PICTURE_MAX_BYTES + 64 * 1024;
/** Values in one message: a large object graph costs the main thread tens of ms to clone. */
const MAX_NODES = 4096;
/** Calls a frame may have unanswered at once. */
const MAX_IN_FLIGHT = 32;
/**
 * What a frame may make the page read a second, refused messages included (the
 * page copied them all the same): messages, and bytes copied (a Blob or a bitmap
 * crosses as a handle). Ten hit masks a second and every paced call fit well under.
 */
const FLOOD_MESSAGES = [200, 400] as const;
const FLOOD_BYTES = [8 * 1024 * 1024, 16 * 1024 * 1024] as const;

const v = z.literal(RPC_VERSION);
/** Frame → host. */
export const frameMessageSchema = z.discriminatedUnion("t", [
  z.object({ v, t: z.literal("ready") }).strict(),
  z.object({ v, t: z.literal("mounted") }).strict(),
  // The view's cleanup ran (asked by "unmount"): its frame may go.
  z.object({ v, t: z.literal("unmounted") }).strict(),
  // A slot sized by its content: the height (CSS px) of what the view holds.
  z.object({ v, t: z.literal("size"), h: z.number().min(0).max(100_000) }).strict(),
  // Twice a second, with the frame's own long-task time since the last one (the watchdog's).
  z.object({ v, t: z.literal("beat"), busy: z.number().min(0).max(60_000) }).strict(),
  z.object({ v, t: z.literal("failed"), reason: z.string().max(500) }).strict(),
  z
    .object({
      v,
      t: z.literal("call"),
      id: z.number().int().min(1).max(2 ** 31),
      m: z.string().min(1).max(48),
      a: z.array(z.unknown()).max(8),
      // The gestures its bootstrap had told the host over its own port when it called.
      g: z.number().int().min(0).max(2 ** 31).optional(),
    })
    .strict(),
]);
export type FrameMessage = z.infer<typeof frameMessageSchema>;

/** Host → frame. */
export type HostMessage =
  | {
      v: typeof RPC_VERSION;
      t: "init";
      role: "view" | "runtime";
      moduleId: string;
      slot: string | null;
      locale: "en" | "it";
      capabilities: readonly ModuleCapability[];
      catalog: unknown;
      /** Sized by its content: the view tells its height. */
      fit: boolean;
      /** Room (CSS px) the frame has past its box on each side, e.g. for a shadow: the module's box keeps the slot's size. */
      room?: { top: number; right: number; bottom: number; left: number };
    }
  | { v: typeof RPC_VERSION; t: "res"; id: number; ok: true; value: unknown }
  | { v: typeof RPC_VERSION; t: "res"; id: number; ok: false; error: string }
  | { v: typeof RPC_VERSION; t: "push"; id: number; value: unknown }
  | { v: typeof RPC_VERSION; t: "activate"; how?: HitActivation }
  // The view's host box (its hit area's button) took or lost the focus.
  | { v: typeof RPC_VERSION; t: "hit-focus"; focused: boolean; visible: boolean }
  // Its shape being carried ("drag").
  | { v: typeof RPC_VERSION; t: "drag"; d: HitDrag }
  // Before init: the port its bootstrap tells the person's gestures on (the module's code never has it).
  | { v: typeof RPC_VERSION; t: "own" }
  | { v: typeof RPC_VERSION; t: "unmount" }
  | { v: typeof RPC_VERSION; t: "runtime-gone" }
  | { v: typeof RPC_VERSION; t: "port"; slot: string };

export type MethodContext = {
  /** Sends a subscription's value (`id` chosen by the frame). */
  push(id: number, value: unknown): void;
  /** Undone when the peer goes. */
  own(off: () => void): () => void;
};

export type Method = {
  cap?: ModuleCapability;
  /** Calls per second, and the burst allowed. */
  rate: readonly [perSecond: number, burst: number];
  /** Its rate is the module's, shared by all its frames (it costs the server or the page's thread). */
  shared?: boolean;
  /** Its Blobs may pass the message cap, up to DOWNLOAD_LARGE_MAX_BYTES (a handle: the page copies none of it). */
  large?: boolean;
  invoke(args: unknown, ctx: MethodContext): unknown;
};

class RpcRefusal extends Error {}

/** A method whose arguments are parsed by `args` before `run` sees them. */
export function method<S extends z.ZodType<readonly unknown[]>>(def: {
  args: S;
  cap?: ModuleCapability;
  rate: readonly [number, number];
  shared?: boolean;
  large?: boolean;
  run(args: z.infer<S>, ctx: MethodContext): unknown;
}): Method {
  return {
    cap: def.cap,
    rate: def.rate,
    shared: def.shared,
    large: def.large,
    invoke(raw, ctx) {
      const parsed = def.args.safeParse(raw);
      if (!parsed.success) throw new RpcRefusal("bad-arguments");
      return def.run(parsed.data, ctx);
    },
  };
}

const isA = (x: object, name: string) => {
  const C: unknown = (globalThis as Record<string, unknown>)[name];
  return typeof C === "function" && x instanceof C;
};

/**
 * Estimated size of a message, or null when it may not cross: too big, too
 * many values, or a type the host never takes (an OffscreenCanvas between
 * the app and a module frame breaks the frame; class instances, functions).
 */
export function messageBytes(value: unknown, max = RPC_MAX_BYTES): number | null {
  const m = measure(value, max);
  return m && m.total <= max ? m.total : null;
}

/** A message's estimated size, how much of it the page copies (strings, arrays, binary), and its Blobs' (up to `blobMax` when more than `max`). */
function measure(value: unknown, max: number, blobMax = max): { total: number; copied: number; blobs: number } | null {
  let total = 0;
  let handles = 0;
  let blobs = 0;
  let nodes = 0;
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const x = stack.pop();
    if (++nodes > MAX_NODES) return null;
    switch (typeof x) {
      case "string":
        total += x.length * 2;
        break;
      case "number":
      case "boolean":
      case "undefined":
        total += 8;
        break;
      case "object": {
        if (x === null) {
          total += 8;
          break;
        }
        if (seen.has(x)) break;
        seen.add(x);
        if (isA(x, "OffscreenCanvas")) return null;
        if (x instanceof Blob) {
          total += x.size;
          handles += x.size;
          blobs += x.size;
        } else if (x instanceof ArrayBuffer) total += x.byteLength;
        else if (ArrayBuffer.isView(x)) total += x.byteLength;
        else if (isA(x, "ImageBitmap")) {
          const px = (x as ImageBitmap).width * (x as ImageBitmap).height * 4;
          total += px;
          handles += px;
        } else if (isA(x, "MessagePort")) total += 8;
        else if (Array.isArray(x)) {
          if (x.length > MAX_NODES) return null;
          stack.push(...(x as unknown[]));
        } else {
          const proto: unknown = Object.getPrototypeOf(x);
          if (proto !== Object.prototype && proto !== null) return null;
          const keys = Object.keys(x);
          if (keys.length > MAX_NODES) return null;
          for (const k of keys) {
            total += k.length * 2;
            stack.push((x as Record<string, unknown>)[k]);
          }
        }
        break;
      }
      default:
        return null;
    }
    if (total - blobs > max || blobs > Math.max(max, blobMax)) return null;
  }
  return { total, copied: total - handles, blobs };
}

/** Token buckets by method: a peer's own, or one module's for its shared methods. */
export const createRateBuckets = () => new Map<string, { tokens: number; at: number }>();
export type RateBuckets = ReturnType<typeof createRateBuckets>;

export type Refusal = "source" | "origin" | "flood" | "size" | "schema" | "unknown-method" | "capability" | "rate-limited" | "busy" | "disposed";

export type RpcPeerOptions = {
  /** The frame's window now (`iframe.contentWindow`); null before it exists. */
  source: () => unknown;
  post: (message: HostMessage, transfer: Transferable[]) => void;
  capabilities: readonly ModuleCapability[];
  methods: Readonly<Record<string, Method>>;
  /** The module's buckets, for its shared methods (without them each peer counts its own). */
  buckets?: RateBuckets;
  now?: () => number;
  onReady?(): void;
  onMounted?(): void;
  onUnmounted?(): void;
  onSize?(height: number): void;
  onBeat?(busyMs: number): void;
  onFailed?(reason: string): void;
  /** A message dropped: the frame sends more than the page may read (it is told once a message). */
  onFlood?(): void;
  /** The page's own time spent on one of the frame's messages (checks, parsing, its handler's work before any wait). */
  onCost?(ms: number): void;
  /** A message refused (not counted: other windows' messages, which are none of this peer's business). */
  onRefused?(why: Refusal, method?: string): void;
  /** A view's call waits for its own reports up to `g` (null: they are in). */
  settle?(g: number): Promise<void> | null;
};

export type ReceiveResult = { ok: true } | { ok: false; why: Refusal };

/** One frame's peer: `receive` every window message; it reads only its frame's. */
export function createRpcPeer(o: RpcPeerOptions) {
  const now = o.now ?? (() => performance.now());
  const buckets = createRateBuckets();
  const owned = new Set<() => void>();
  // What this frame may still make the page read (refilled with time).
  const flood: { messages: number; bytes: number; at: number } = { messages: FLOOD_MESSAGES[1], bytes: FLOOD_BYTES[1], at: now() };
  const afford = (bytes: number) => {
    const t = now();
    const s = (t - flood.at) / 1000;
    flood.at = t;
    flood.messages = Math.min(FLOOD_MESSAGES[1], flood.messages + s * FLOOD_MESSAGES[0]);
    flood.bytes = Math.min(FLOOD_BYTES[1], flood.bytes + s * FLOOD_BYTES[0]);
    if (flood.messages < 1 || flood.bytes < bytes) return false;
    flood.messages -= 1;
    flood.bytes -= bytes;
    return true;
  };
  let inFlight = 0;
  let disposed = false;

  const post = (m: HostMessage, transfer: Transferable[] = []) => {
    if (!disposed) o.post(m, transfer);
  };
  const ctx: MethodContext = {
    push: (id, value) => post({ v: RPC_VERSION, t: "push", id, value }),
    own(off) {
      if (disposed) {
        off();
        return () => {};
      }
      owned.add(off);
      return () => {
        if (owned.delete(off)) off();
      };
    },
  };

  const take = (name: string, { rate: [perSecond, burst], shared }: Method) => {
    const t = now();
    const from = shared && o.buckets ? o.buckets : buckets;
    const b = from.get(name) ?? { tokens: burst, at: t };
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSecond);
    b.at = t;
    from.set(name, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };

  const refuse = (why: Refusal, m?: string, id?: number): ReceiveResult => {
    o.onRefused?.(why, m);
    if (id !== undefined) post({ v: RPC_VERSION, t: "res", id, ok: false, error: why });
    return { ok: false, why };
  };

  const handle = (e: { origin: string; data: unknown }): ReceiveResult => {
    if (e.origin !== "null") return refuse("origin");
    const size = measure(e.data, RPC_MAX_BYTES, DOWNLOAD_LARGE_MAX_BYTES);
    // An oversized one cost the page its copy all the same: counted at the cap.
    if (!afford(size ? size.copied : RPC_MAX_BYTES)) {
      o.onFlood?.();
      return refuse("flood");
    }
    if (size === null) return refuse("size");
    const parsed = frameMessageSchema.safeParse(e.data);
    if (!parsed.success) return refuse("schema");
    const msg = parsed.data;
    if (msg.t === "ready") o.onReady?.();
    else if (msg.t === "mounted") o.onMounted?.();
    else if (msg.t === "unmounted") o.onUnmounted?.();
    else if (msg.t === "size") o.onSize?.(msg.h);
    else if (msg.t === "beat") o.onBeat?.(msg.busy);
    else if (msg.t === "failed") o.onFailed?.(msg.reason);
    else {
      const def = Object.hasOwn(o.methods, msg.m) ? o.methods[msg.m] : undefined;
      if (!def) return refuse("unknown-method", msg.m, msg.id);
      if (def.cap && !o.capabilities.includes(def.cap)) return refuse("capability", msg.m, msg.id);
      if (size.total > RPC_MAX_BYTES && !def.large) return refuse("size", msg.m, msg.id);
      if (!take(msg.m, def)) return refuse("rate-limited", msg.m, msg.id);
      if (inFlight >= MAX_IN_FLIGHT) return refuse("busy", msg.m, msg.id);
      inFlight++;
      const id = msg.id;
      const held = msg.g ? (o.settle?.(msg.g) ?? null) : null;
      void (async () => {
        try {
          if (held) await held;
          const value: unknown = await def.invoke(msg.a, ctx);
          post({ v: RPC_VERSION, t: "res", id, ok: true, value: value ?? null });
        } catch (err) {
          const error = err instanceof Error ? err.message.slice(0, 200) : "failed";
          post({ v: RPC_VERSION, t: "res", id, ok: false, error });
        } finally {
          inFlight--;
        }
      })();
    }
    return { ok: true };
  };

  return {
    receive(e: { source: unknown; origin: string; data: unknown }): ReceiveResult {
      const mine = o.source();
      if (mine === null || mine === undefined || e.source !== mine) return { ok: false, why: "source" };
      if (disposed) return { ok: false, why: "disposed" };
      const t0 = now();
      try {
        return handle(e);
      } finally {
        o.onCost?.(now() - t0);
      }
    },
    /** A message to the frame (init, activate, unmount, a port). */
    send: post,
    dispose() {
      disposed = true;
      [...owned].forEach(off => off());
      owned.clear();
    },
  };
}

export type RpcPeer = ReturnType<typeof createRpcPeer>;
