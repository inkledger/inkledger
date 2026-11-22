import { z } from "zod";
import { PICTURE_MAX_BYTES, type ModuleCapability } from "@contracts/modules";
import type { HitActivation } from "../hostV2";

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
  invoke(args: unknown, ctx: MethodContext): unknown;
};

class RpcRefusal extends Error {}

/** A method whose arguments are parsed by `args` before `run` sees them. */
export function method<S extends z.ZodType<readonly unknown[]>>(def: {
  args: S;
  cap?: ModuleCapability;
  rate: readonly [number, number];
  run(args: z.infer<S>, ctx: MethodContext): unknown;
}): Method {
  return {
    cap: def.cap,
    rate: def.rate,
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
  let total = 0;
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
        if (x instanceof Blob) total += x.size;
        else if (x instanceof ArrayBuffer) total += x.byteLength;
        else if (ArrayBuffer.isView(x)) total += x.byteLength;
        else if (isA(x, "ImageBitmap")) total += (x as ImageBitmap).width * (x as ImageBitmap).height * 4;
        else if (isA(x, "MessagePort")) total += 8;
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
    if (total > max) return null;
  }
  return total;
}

export type Refusal = "source" | "origin" | "size" | "schema" | "unknown-method" | "capability" | "rate-limited" | "busy" | "disposed";

export type RpcPeerOptions = {
  /** The frame's window now (`iframe.contentWindow`); null before it exists. */
  source: () => unknown;
  post: (message: HostMessage, transfer: Transferable[]) => void;
  capabilities: readonly ModuleCapability[];
  methods: Readonly<Record<string, Method>>;
  now?: () => number;
  onReady?(): void;
  onMounted?(): void;
  onUnmounted?(): void;
  onSize?(height: number): void;
  onBeat?(busyMs: number): void;
  onFailed?(reason: string): void;
  /** A message refused (not counted: other windows' messages, which are none of this peer's business). */
  onRefused?(why: Refusal, method?: string): void;
};

export type ReceiveResult = { ok: true } | { ok: false; why: Refusal };

/** One frame's peer: `receive` every window message; it reads only its frame's. */
export function createRpcPeer(o: RpcPeerOptions) {
  const now = o.now ?? (() => performance.now());
  const buckets = new Map<string, { tokens: number; at: number }>();
  const owned = new Set<() => void>();
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

  const take = (name: string, [perSecond, burst]: readonly [number, number]) => {
    const t = now();
    const b = buckets.get(name) ?? { tokens: burst, at: t };
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSecond);
    b.at = t;
    buckets.set(name, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };

  const refuse = (why: Refusal, m?: string, id?: number): ReceiveResult => {
    o.onRefused?.(why, m);
    if (id !== undefined) post({ v: RPC_VERSION, t: "res", id, ok: false, error: why });
    return { ok: false, why };
  };

  return {
    receive(e: { source: unknown; origin: string; data: unknown }): ReceiveResult {
      const mine = o.source();
      if (mine === null || mine === undefined || e.source !== mine) return { ok: false, why: "source" };
      if (disposed) return { ok: false, why: "disposed" };
      if (e.origin !== "null") return refuse("origin");
      if (messageBytes(e.data) === null) return refuse("size");
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
        if (!take(msg.m, def.rate)) return refuse("rate-limited", msg.m, msg.id);
        if (inFlight >= MAX_IN_FLIGHT) return refuse("busy", msg.m, msg.id);
        inFlight++;
        const id = msg.id;
        void (async () => {
          try {
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
