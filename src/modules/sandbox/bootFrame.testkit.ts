import vm from "node:vm";
import { BOOTSTRAP } from "../../../api/modules/frame";
import type { ModuleCapability } from "@contracts/modules";
import { createRpcPeer, RPC_VERSION, type HostMessage, type Method } from "./rpc";

/**
 * The frame's bootstrap run for real (node:vm, the entry's import stubbed)
 * against a real host peer: what a module calls in its frame, as the host
 * receives it. No DOM: the few objects it touches are faked.
 */
export function bootFrame(o: {
  capabilities: ModuleCapability[];
  mod: unknown;
  methods: Record<string, Method>;
  role?: "view" | "runtime";
  slot?: string;
  /** More of the frame's window (an OffscreenCanvas, say). */
  globals?: Record<string, unknown>;
  onUnmounted?(): void;
  /** The view's port to its runtime, given with init. */
  port?: MessagePort;
  /** A slot sized by its content: the frame tells its height. */
  fit?: boolean;
  onSize?(h: number): void;
  /** Room the frame has past its box. */
  room?: { top: number; right: number; bottom: number; left: number };
  /** The bootstrap's own port for the person's gestures, handed before init. */
  own?: MessagePort;
  /** Holds a call until the own reports it follows have arrived. */
  settle?(g: number): Promise<void> | null;
  /** The frame's beats to the watchdog, with its busy time. */
  onBeat?(busyMs: number): void;
}) {
  const frameListeners: ((e: unknown) => void)[] = [];
  const pagehides: (() => void)[] = [];
  const focuses: ((e: unknown) => void)[] = [];
  const inputs = new Map<string, ((e: unknown) => void)[]>();
  const parentWin = {
    postMessage(m: unknown, _origin: string, transfer: Transferable[] = []) {
      // Into the host's realm, as the browser's structured clone would.
      const data: unknown = structuredClone(m, { transfer });
      queueMicrotask(() => peer.receive({ source: frameWin, origin: "null", data }));
    },
  };
  const frameWin = {};
  const box = { id: "", style: {}, dataset: {} as Record<string, string> };
  const styles = new Map<string, { id: string; textContent: string }>();
  const keys: ((e: { key: string }) => void)[] = [];
  const doc: { activeElement: unknown; [k: string]: unknown } = {
    activeElement: null,
    createElement: (tag: string) => (tag === "style" ? { id: "", textContent: "" } : box),
    getElementById: (id: string) => styles.get(id) ?? null,
    body: { append() {} },
    head: { append: (el: { id: string; textContent: string }) => void styles.set(el.id, el) },
    addEventListener: (t: string, fn: (e: { key: string }) => void) => t === "keydown" && keys.push(fn),
  };
  const errors: unknown[] = [];
  const context = vm.createContext({
    parent: parentWin,
    window: {},
    document: doc,
    location: { href: "http://app.test/modules/frame/x/0" },
    addEventListener: (t: string, fn: (e: unknown) => void) =>
      t === "message" ? frameListeners.push(fn) : t === "pagehide" ? pagehides.push(() => fn({})) : t === "focus" ? focuses.push(fn) : inputs.set(t, [...(inputs.get(t) ?? []), fn]),
    MessagePort,
    Reflect,
    load: async () => ({ default: o.mod }),
    URL,
    Blob,
    setTimeout,
    // The beat to the watchdog (twice a second): not what these tests read.
    setInterval: () => 0,
    clearInterval: () => undefined,
    queueMicrotask,
    structuredClone,
    performance,
    console: { error: (...a: unknown[]) => errors.push(a), warn() {}, log() {} },
    ...o.globals,
  });
  const sent: HostMessage[] = [];
  const peer = createRpcPeer({
    source: () => frameWin,
    post(m, transfer) {
      sent.push(m);
      // Ports go with the event, as the browser's would (cloning them over would close them).
      const ports = transfer.filter(t => t instanceof MessagePort);
      const data: unknown = structuredClone(m, { transfer: transfer.filter(t => !(t instanceof MessagePort)) });
      queueMicrotask(() => frameListeners.forEach(fn => fn({ source: parentWin, data, ports })));
    },
    capabilities: o.capabilities,
    methods: o.methods,
    onUnmounted: () => o.onUnmounted?.(),
    onSize: h => o.onSize?.(h),
    settle: g => o.settle?.(g) ?? null,
    onBeat: b => o.onBeat?.(b),
    onReady() {
      if (o.own) peer.send({ v: RPC_VERSION, t: "own" }, [o.own]);
      peer.send({ v: RPC_VERSION, t: "init", role: o.role ?? "view", moduleId: "m", slot: o.slot ?? "dashboard-widget", locale: "en", capabilities: o.capabilities, catalog: {}, fit: o.fit ?? false, ...(o.room ? { room: o.room } : {}) }, o.port ? [o.port] : []);
    },
  });
  vm.runInContext(BOOTSTRAP, context);
  return {
    /** The frame's global, as the module's own code sees it. */
    win: context as { setTimeout(fn: () => void, ms?: number): unknown },
    peer,
    sent,
    box,
    errors,
    styles,
    keydown: (key: string) => keys.forEach(fn => fn({ key })),
    pagehide: () => pagehides.forEach(fn => fn()),
    /** The fake document's body: what has the focus when nothing else does. */
    body: doc.body,
    /** The frame's focused element (the fake document's). */
    setActive: (el: unknown) => void (doc.activeElement = el),
    /** The frame's window takes the focus (the host focused its iframe; `isTrusted`: the browser's). */
    focus: (e: { isTrusted?: boolean } = {}) => focuses.forEach(fn => fn(e)),
    /** An input event on the frame's window (`isTrusted`: the browser's, not a script's). */
    input: (type: string, e: { isTrusted: boolean }) => inputs.get(type)?.forEach(fn => fn(e)),
  };
}

/** Lets the messages both ways go round. */
export const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
};
