import type { ModuleListEntry, SlotId } from "@contracts/modules";
import { currentLocale } from "@/i18n";
import { SURFACES } from "@/components/app/surface";
import type { Hub } from "../host";
import { frameMethods } from "./methods";
import { capabilityMethods } from "./capabilities";
import { createPageLight } from "./light";
import { browserBroker, createBroker } from "./broker";
import { browserPage } from "./importance";
import { createLayoutFeed, createPointerFeed, watchBlur } from "./feeds";
import { createModuleCache, indexedDbCache } from "./cache";
import { sidebar } from "@/hooks/useSidebar";
import { createRpcPeer, RPC_VERSION, type HostMessage, type RpcPeer } from "./rpc";

/**
 * Framed modules on the page: one sandboxed view frame per slot mount, and
 * one persistent runtime frame per module that asks for one ("runtime"),
 * with a port between each view and the runtime. Frames are made when the
 * page is idle, never moved (a moved frame reloads), and a frame that loads
 * again (it navigated) stops its whole module for the session.
 */

/** Live frames on a page, at most: each costs a document (and the first, a process). */
const MAX_FRAMES = 8;

let live = 0;
const peers = new Set<RpcPeer>();
const killed = new Set<string>();
const onKill = new Map<string, Set<() => void>>();

const onMessage = (e: MessageEvent) => peers.forEach(p => p.receive(e));
const addPeer = (p: RpcPeer) => {
  if (peers.size === 0) window.addEventListener("message", onMessage);
  peers.add(p);
  return () => {
    peers.delete(p);
    p.dispose();
    if (peers.size === 0) window.removeEventListener("message", onMessage);
  };
};

const idle = (fn: () => void) => {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(fn, { timeout: 2000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(fn, 1);
  return () => clearTimeout(id);
};

const locale = (): "en" | "it" => (currentLocale() === "it" ? "it" : "en");

let broker: ReturnType<typeof createBroker> | null = null;
let pointer: ReturnType<typeof createPointerFeed> | null = null;
let cache: ReturnType<typeof createModuleCache> | null = null;
let layout: ReturnType<typeof createLayoutFeed> | null = null;
const layoutFeed = () =>
  (layout ??= createLayoutFeed({
    rail: sidebar.collapsed,
    docked: () => document.querySelector('[data-module-slot="mobile-dock"] [data-docked]') !== null,
    subscribe: sidebar.subscribe,
  }));
const blur = (box: Element, push: (px: number) => void) =>
  watchBlur(box, push, {
    style: e => getComputedStyle(e),
    observe(e, fn) {
      const o = new MutationObserver(fn);
      o.observe(e, { attributes: true, attributeFilter: ["style"] });
      return () => o.disconnect();
    },
  });
let pageLight: ReturnType<typeof createPageLight> | null = null;
const light = () =>
  (pageLight ??= createPageLight(
    {
      root: document.documentElement.style,
      addStyle(css) {
        const el = document.createElement("style");
        el.id = "ikl-surface-light";
        el.textContent = css;
        document.head.append(el);
        return el;
      },
    },
    SURFACES,
  ));

/** A module that navigated: all its frames go, and it stays off until the page reloads. */
function kill(id: string, why: string) {
  if (killed.has(id)) return;
  killed.add(id);
  console.warn(`[module ${id}] stopped: ${why}`);
  [...(onKill.get(id) ?? [])].forEach(f => f());
}

const whenKilled = (id: string, fn: () => void) => {
  const set = onKill.get(id) ?? new Set();
  onKill.set(id, set);
  set.add(fn);
  return () => void set.delete(fn);
};

type Frame = { iframe: HTMLIFrameElement; stop: () => void };

/**
 * One sandboxed frame of a module, its messages served from the hub's API for
 * it. `init` is what it gets once it says ready (with `transfer`).
 */
function openFrame(
  hub: Hub,
  entry: ModuleListEntry,
  slot: SlotId,
  parent: HTMLElement,
  role: "view" | "runtime",
  ready: (peer: RpcPeer) => Transferable[],
): Frame | null {
  if (!entry.frameUrl || killed.has(entry.id) || live >= MAX_FRAMES) return null;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.dataset.moduleFrame = role;
  iframe.title = entry.name[locale()];
  if (role === "runtime") {
    iframe.setAttribute("allow", "autoplay");
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
  }
  // Same colour scheme as the frame's document, or the browser paints it opaque.
  Object.assign(iframe.style, { display: "block", border: "0", width: role === "view" ? "100%" : "0", height: role === "view" ? "100%" : "0", colorScheme: "normal", background: "transparent" });
  const { api, cas, dispose: disposeApi } = hub.apiFor(entry.id, slot);
  const box = role === "view" ? { el: parent, slot, activate: () => peer.send({ v: RPC_VERSION, t: "activate" }), onDock: () => layoutFeed().poke() } : null;
  const served = frameMethods(api, cas, box);
  const caps = capabilityMethods({ moduleId: entry.id, view: box, light: light(), broker: (broker ??= createBroker(browserBroker())), page: browserPage, pointer: (pointer ??= createPointerFeed(window)), layout: layoutFeed(), blur, cache: (cache ??= createModuleCache(indexedDbCache())) });
  let initialised = false;
  const warned = new Set<string>();
  const peer = createRpcPeer({
    source: () => iframe.contentWindow,
    post: (m: HostMessage, transfer) => iframe.contentWindow?.postMessage(m, "*", transfer),
    capabilities: entry.capabilities,
    methods: { ...served.methods, ...caps.methods },
    onReady() {
      if (initialised) return;
      initialised = true;
      const transfer = ready(peer);
      peer.send(
        { v: RPC_VERSION, t: "init", role, moduleId: entry.id, slot: role === "view" ? slot : null, locale: locale(), capabilities: entry.capabilities, catalog: SURFACES },
        transfer,
      );
    },
    onMounted: () => (iframe.dataset.state = "live"),
    onFailed(reason) {
      iframe.dataset.state = "failed";
      console.error(`[module ${entry.id}] ${reason}`);
    },
    onRefused(why, m) {
      if (warned.has(why)) return;
      warned.add(why);
      console.warn(`[module ${entry.id}] refused ${m ?? "a message"}: ${why}`);
    },
  });
  const removePeer = addPeer(peer);
  let loads = 0;
  // The first load is the document; any later one is the frame navigating (blocked or not).
  iframe.addEventListener("load", () => {
    if (++loads > 1) kill(entry.id, "its frame navigated");
  });
  iframe.src = entry.frameUrl;
  live++;
  parent.append(iframe);
  // TODO(sandbox phase 3): heartbeat and long-task attribution per frame feed the watchdog here.
  let stopped = false;
  return {
    iframe,
    stop() {
      if (stopped) return;
      stopped = true;
      live--;
      removePeer();
      served.dispose();
      caps.dispose();
      disposeApi();
      iframe.remove();
    },
  };
}

// ---- Runtime frames: one per module, in a container that never moves ----

type Runtime = { hub: Hub; frame: Frame | null; ready: boolean; waiting: [MessagePort, SlotId][]; peer: RpcPeer | null; offKill: () => void };
const runtimes = new Map<string, Runtime>();
let shelf: HTMLElement | null = null;

const shelfEl = () => {
  if (shelf?.isConnected) return shelf;
  shelf = document.createElement("div");
  shelf.dataset.moduleRuntimes = "";
  shelf.setAttribute("aria-hidden", "true");
  Object.assign(shelf.style, { position: "fixed", left: "0", top: "0", width: "0", height: "0", overflow: "hidden" });
  document.body.append(shelf);
  return shelf;
};

function stopRuntime(id: string) {
  const r = runtimes.get(id);
  if (!r) return;
  runtimes.delete(id);
  r.offKill();
  r.frame?.stop();
  r.waiting.forEach(([p]) => p.close());
}

/** The module's runtime, made with its first view; a view's port reaches it once it is ready. */
function connectRuntime(hub: Hub, entry: ModuleListEntry, slot: SlotId, port: MessagePort) {
  let r = runtimes.get(entry.id);
  if (r && r.hub !== hub) {
    stopRuntime(entry.id);
    r = undefined;
  }
  if (!r) {
    const made: Runtime = { hub, frame: null, ready: false, waiting: [], peer: null, offKill: () => {} };
    runtimes.set(entry.id, made);
    made.frame = openFrame(hub, entry, entry.slots[0] ?? slot, shelfEl(), "runtime", peer => {
      made.ready = true;
      made.peer = peer;
      queueMicrotask(() => made.waiting.splice(0).forEach(([p, s]) => peer.send({ v: RPC_VERSION, t: "port", slot: s }, [p])));
      return [];
    });
    if (!made.frame) {
      runtimes.delete(entry.id);
      port.close();
      return;
    }
    made.offKill = whenKilled(entry.id, () => stopRuntime(entry.id));
    r = made;
  }
  if (r.ready && r.peer) r.peer.send({ v: RPC_VERSION, t: "port", slot }, [port]);
  else r.waiting.push([port, slot]);
}

/** Lets go of the runtimes of modules no longer running (all of them with no list). */
export function keepRuntimes(ids: readonly string[] = []) {
  for (const id of [...runtimes.keys()]) if (!ids.includes(id)) stopRuntime(id);
}

export function mountView(hub: Hub, entry: ModuleListEntry, slot: SlotId, box: HTMLElement): () => void {
  let frame: Frame | null = null;
  const stop = () => {
    frame?.stop();
    frame = null;
  };
  // After the page has painted: a frame never costs a route change its frame.
  const cancel = idle(() => {
    frame = openFrame(hub, entry, slot, box, "view", () => {
      if (!entry.capabilities.includes("runtime")) return [];
      const channel = new MessageChannel();
      connectRuntime(hub, entry, slot, channel.port1);
      return [channel.port2];
    });
  });
  const offKill = whenKilled(entry.id, stop);
  return () => {
    cancel();
    offKill();
    stop();
  };
}
