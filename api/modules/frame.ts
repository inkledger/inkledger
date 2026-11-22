import { MODULES_RUN_PATH } from "@contracts/modules";

/**
 * A framed module's document: sandboxed (opaque origin: no cookie, storage or
 * DOM of the app), scripts only by nonce or from the module code route, no
 * network at all. Served, not srcdoc: srcdoc would inherit the app's policy.
 */
export const frameCsp = (origin: string, nonce: string) =>
  [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${origin}${MODULES_RUN_PATH}/`,
    "worker-src blob:",
    "img-src blob: data:",
    "media-src blob:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join("; ");

// "<" escaped: nothing in the JSON can close its script element.
const LT = "\\" + "u003c";
const inlineJson = (v: unknown) => JSON.stringify(v).replace(/</g, LT);

/**
 * What runs in the frame before the module: no peer connections, popups or
 * print; Worker shimmed to work in an opaque frame; the host API rebuilt over
 * messages to the parent. Says ready, gets its role, then imports the entry.
 */
export const BOOTSTRAP = `const V = 1;
const quiet = () => {};
const abs = (u) => new URL(u, location.href).href;
const report = (e) => console.error("[module]", e);
const safe = (fn, ...a) => { try { fn(...a); } catch (e) { report(e); } };
// Defence in depth (the policy already allows no network): no peer connections, popups or print dialogs.
for (const k of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCSessionDescription", "RTCIceCandidate"]) {
  try { Object.defineProperty(window, k, { value: undefined, writable: false, configurable: false }); } catch { /* not there */ }
}
for (const [k, value] of [["open", () => null], ["print", quiet]]) {
  try { Object.defineProperty(window, k, { value, writable: false, configurable: false }); } catch { /* kept */ }
}
// A module worker fails in an opaque frame: a classic blob worker imports the
// code instead, holding what was posted to it until the code is there.
const NativeWorker = window.Worker;
const stub = (u) => "const q=[];const h=e=>q.push(e);addEventListener('message',h);import(" + JSON.stringify(u) +
  ").then(()=>{removeEventListener('message',h);for(const e of q)dispatchEvent(new MessageEvent('message',{data:e.data,ports:[...e.ports]}))},err=>setTimeout(()=>{throw err}));";
if (NativeWorker) {
  window.Worker = class Worker extends NativeWorker {
    constructor(url, options) {
      const href = abs(String(url));
      if (!/^https?:/.test(href)) super(url, options);
      else super(URL.createObjectURL(new Blob([stub(href)], { type: "text/javascript" })), options && options.name ? { name: options.name } : undefined);
    }
  };
}

// The host API over messages to the parent; nothing synchronous.
let seq = 0;
let started = false;
let activate = null;
let onView = null;
const pending = new Map();
const pushes = new Map();
const waitingViews = [];
const send = (m, transfer) => parent.postMessage(Object.assign({ v: V }, m), "*", transfer || []);
const call = (m, a) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  send({ t: "call", id, m, a: a || [] });
});
const fire = (m, a) => void call(m, a).catch(report);
// A value with subscribers: one subscription at the host, the latest kept for late subscribers.
const state = (name) => {
  const fns = new Set();
  let id = 0, has = false, last;
  return (fn) => {
    fns.add(fn);
    if (has) safe(fn, last);
    if (!id) {
      id = ++seq;
      pushes.set(id, (v) => { last = v; has = true; for (const f of [...fns]) safe(f, v); });
      fire("sub", [id, name]);
    }
    return () => {
      if (!fns.delete(fn) || fns.size > 0 || !id) return;
      pushes.delete(id);
      fire("unsub", [id]);
      id = 0;
      has = false;
    };
  };
};
const on = (name, fn) => {
  const id = ++seq;
  pushes.set(id, (d) => safe(fn, d));
  fire("sub", [id, "event", name]);
  return () => { if (pushes.delete(id)) fire("unsub", [id]); };
};
const views = (fn) => {
  onView = fn;
  for (const [port, slot] of waitingViews.splice(0)) safe(fn, port, slot);
  return () => { onView = null; };
};

async function start(init, port) {
  const has = (c) => init.capabilities.includes(c);
  const host = {
    version: 2,
    moduleId: init.moduleId,
    locale: init.locale,
    timer: state("timer"),
    today: state("today"),
    theme: state("theme"),
    budget: state("budget"),
    totals: () => call("totals"),
    history: { daily: (since) => call("history.daily", since === undefined ? [] : [since]) },
    weather: (at) => call("weather", [{ lat: at.lat, lon: at.lon }]),
    geocode: (q) => call("geocode", [q]),
    on,
    surfaces: { catalog: () => init.catalog },
    openSettings: () => fire("openSettings"),
    files: {
      get: (k) => call("files.get", [k]),
      put: (k, b) => call("files.put", [k, b]).then(quiet),
      delete: (k) => call("files.delete", [k]).then(quiet),
    },
    storage: {
      get: (k) => call("storage.get", [k]),
      set: (k, v) => call("storage.set", [k, v]).then(quiet),
      delete: (k) => call("storage.delete", [k]).then(quiet),
      // Run here over a read and a write that holds only if nobody wrote meanwhile.
      update: async (key, change) => {
        let r = await call("storage.read", [key]);
        for (let i = 0; i < 8; i++) {
          const next = change(r.value);
          const w = await call("storage.setIf", [key, next, r.revision]);
          if (w.ok) return next;
          r = w;
        }
        throw new Error("storage.update: " + JSON.stringify(key) + " kept changing elsewhere");
      },
    },
  };
  if (has("surfaces.light")) host.surfaces.light = (vars) => fire("surfaces.light", [vars == null ? null : Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)]))]);
  if (has("dock")) host.dock = { set: (on) => fire("dock.set", [Boolean(on)]) };
  if (has("backdrop.preblurred")) host.backdrop = { preblurred: (on) => fire("backdrop.preblurred", [Boolean(on)]) };
  const fail = (what, e) => send({ t: "failed", reason: (what + ": " + String((e && e.message) || e)).slice(0, 400) });
  let mod;
  try {
    // Pinned by the import map's integrity: other bytes never run.
    mod = (await load()).default;
  } catch (e) {
    return fail("load", e);
  }
  if (!mod || mod.id !== init.moduleId || mod.hostApi !== 2 || typeof mod.mount !== "object" || !mod.mount) return fail("load", "not an inkledger module (v2)");
  try {
    if (init.role === "runtime") {
      if (typeof mod.runtime === "function") mod.runtime(Object.assign(host, { views }));
    } else {
      const mount = mod.mount[init.slot];
      if (typeof mount !== "function") throw new Error("nothing to mount in " + init.slot);
      host.slot = init.slot;
      host.hit = { set: (regions, fn) => { activate = typeof fn === "function" ? fn : null; fire("hit.set", [regions]); } };
      if (port) host.runtime = port;
      const box = document.createElement("div");
      box.id = "ikl-box";
      document.body.append(box);
      mount(box, host);
    }
    send({ t: "mounted" });
  } catch (e) {
    fail("mount", e);
  }
}

addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const d = e.data;
  if (!d || d.v !== V) return;
  if (d.t === "res") {
    const p = pending.get(d.id);
    if (!p) return;
    pending.delete(d.id);
    if (d.ok) p.resolve(d.value);
    else p.reject(new Error(d.error));
  } else if (d.t === "push") {
    const f = pushes.get(d.id);
    if (f) f(d.value);
  } else if (d.t === "activate") {
    if (activate) safe(activate);
  } else if (d.t === "port") {
    if (!e.ports[0]) return;
    if (onView) safe(onView, e.ports[0], d.slot);
    else waitingViews.push([e.ports[0], d.slot]);
  } else if (d.t === "init" && !started) {
    started = true;
    void start(d, e.ports[0]);
  }
});
send({ t: "ready" });
`;

/** The bootstrap: the import map pins the entry to its hash (SRI) before anything imports it. */
export const frameDocument = (entryUrl: string, integrity: string, nonce: string) => `<!doctype html>
<html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}#ikl-box{position:absolute;inset:0}</style>
<script type="importmap" nonce="${nonce}">${inlineJson({ imports: {}, integrity: { [entryUrl]: integrity } })}</script>
<script type="module" nonce="${nonce}">const ENTRY = ${inlineJson(entryUrl)};
const load = () => import(ENTRY);
${BOOTSTRAP}</script>
</head><body></body></html>
`;
