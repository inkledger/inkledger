import { MODULES_RUN_PATH, PICTURE_MAX_BYTES } from "@contracts/modules";

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
let unmount = null;
// The module's runtime frame gone (or never made): told once, to every listener, late ones too.
let runtimePort = null;
let runtimeGone = false;
const goneFns = new Set();
const runtimeIsGone = () => {
  if (runtimeGone) return;
  runtimeGone = true;
  if (runtimePort) runtimePort.close();
  for (const f of [...goneFns]) safe(f);
  goneFns.clear();
};
const pending = new Map();
const pushes = new Map();
const waitingViews = [];
const send = (m, transfer) => parent.postMessage(Object.assign({ v: V }, m), "*", transfer || []);
// Over the host's picture cap (its message cap leaves room for the rest): refused here, never unanswered.
const MAX_BYTES = ${PICTURE_MAX_BYTES};
const big = (x) => x != null && ((x instanceof Blob && x.size > MAX_BYTES) || ((x instanceof ArrayBuffer || ArrayBuffer.isView(x)) && x.byteLength > MAX_BYTES));
const call = (m, a, transfer) => new Promise((resolve, reject) => {
  if ((a || []).some(big)) return reject(new Error(m + ": too big to send"));
  const id = ++seq;
  pending.set(id, { resolve, reject });
  send({ t: "call", id, m, a: a || [] }, transfer);
});
const fire = (m, a, transfer) => void call(m, a, transfer).catch(report);
// A picture's alpha, scaled to at most 512 px a side: the overlay's shape for the host's hit test.
const alphaMask = (pic) => {
  const k = Math.min(1, 512 / Math.max(pic.width, pic.height, 1));
  const w = Math.max(1, Math.round(pic.width * k)), h = Math.max(1, Math.round(pic.height * k));
  const c = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = c.getContext("2d");
  g.drawImage(pic, 0, 0, w, h);
  const rgba = g.getImageData(0, 0, w, h).data;
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  return { kind: "mask", w, h, alpha };
};
// A value with subscribers: one subscription at the host, the latest kept for late subscribers.
const held = (start, stop) => {
  const fns = new Set();
  let id = 0, has = false, last;
  return (fn) => {
    fns.add(fn);
    if (has) safe(fn, last);
    if (!id) {
      id = ++seq;
      pushes.set(id, (v) => { last = v; has = true; for (const f of [...fns]) safe(f, v); });
      start(id);
    }
    return () => {
      if (!fns.delete(fn) || fns.size > 0 || !id) return;
      pushes.delete(id);
      stop(id);
      id = 0;
      has = false;
    };
  };
};
const state = (name) => held((id) => fire("sub", [id, name]), (id) => fire("unsub", [id]));
const watched = (m) => held((id) => fire(m, [id]), (id) => fire("unwatch", [id]));
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

// A slot sized by its content (settings, sidebar): the height of what the box holds (a scroller
// filling it counts its scrolled content), told the host on each change, never the same twice.
const fitHeight = (box) => {
  let last = -1, queued = false;
  const tell = () => {
    queued = false;
    let h = 0;
    for (const c of Array.from(box.children || [])) h = Math.max(h, (c.offsetTop || 0) + Math.max(c.offsetHeight || 0, c.scrollHeight || 0));
    h = Math.min(100000, Math.ceil(h));
    if (h !== last) { last = h; send({ t: "size", h }); }
  };
  const queue = () => { if (!queued) { queued = true; setTimeout(tell, 0); } };
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(queue);
    const watchAll = () => { ro.observe(box); for (const c of Array.from(box.children || [])) ro.observe(c); };
    watchAll();
    if (typeof MutationObserver === "function") new MutationObserver(() => { watchAll(); queue(); }).observe(box, { childList: true, subtree: true, characterData: true });
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(queue, quiet);
  queue();
};

// The app's look: its tokens (again on every theme change) and its fonts.
const sheet = (id) => {
  let el = document.getElementById(id);
  if (!el) { el = document.createElement("style"); el.id = id; document.head.append(el); }
  return el;
};
const applyLook = (v) => {
  if (!v) return;
  if (typeof v.tokens === "string") sheet("ikl-theme").textContent = v.tokens;
  if (typeof v.fonts === "string") sheet("ikl-fonts").textContent = v.fonts;
};

async function start(init, port) {
  watched("look")(applyLook);
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
    session: {
      get: (k) => call("session.get", [String(k)]),
      set: (k, v) => call("session.set", [String(k), String(v)]).then(quiet),
      delete: (k) => call("session.delete", [String(k)]).then(quiet),
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
  if (has("surfaces.light")) {
    // About one cast a frame (the host's pace), the latest winning: each caller hears how its value, or a later one, went.
    let lightAt = -1000, lightTimer = 0, lightNext = null, lightWaiting = [];
    const castLight = () => {
      lightTimer = 0;
      lightAt = Date.now();
      const args = lightNext, waiting = lightWaiting;
      lightNext = null;
      lightWaiting = [];
      call("surfaces.light", args).then(() => { for (const w of waiting) w.resolve(); }, (e) => { report(e); for (const w of waiting) w.reject(e); });
    };
    host.surfaces.light = (vars, off) => new Promise((resolve, reject) => {
      const v = vars == null ? null : Object.fromEntries(Object.entries(vars).map(([k, x]) => [k, String(x)]));
      lightNext = off == null ? [v] : [v, Array.from(off, String)];
      lightWaiting.push({ resolve, reject });
      if (!lightTimer) lightTimer = setTimeout(castLight, Math.max(0, lightAt + 34 - Date.now()));
    });
  }
  if (has("share")) host.share = (file, name) => call("share", [file, String(name)]);
  if (has("download")) host.download = (file, name) => call("download", [file, String(name)]).then(quiet);
  if (has("open-image")) host.openImage = (file) => call("openImage", [file]).then(quiet);
  if (has("page.importance") && init.role === "view") host.page = { importance: (points) => call("page.importance", [Array.from(points, (p) => [Number(p[0]), Number(p[1])])]) };
  if (has("cache")) host.cache = { get: (k) => call("cache.get", [k]), put: (k, b) => call("cache.put", [k, b]).then(quiet), delete: (k) => call("cache.delete", [k]).then(quiet) };
  if (has("sheet")) host.sheet = { open: () => fire("sheet.open"), close: () => fire("sheet.close") };
  if (has("geo")) host.geo = { here: () => call("geo.here") };
  if (has("dock")) host.dock = { set: (on) => fire("dock.set", [Boolean(on)]) };
  if (has("backdrop.preblurred")) host.backdrop = { preblurred: (on) => fire("backdrop.preblurred", [Boolean(on)]), blur: watched("backdrop.blur") };
  if (has("pointer") && init.role === "view") host.pointer = watched("pointer");
  if (has("layout")) host.layout = watched("layout");
  // The page moved under the frame (scroll, resize, a route, a fold, a sheet): told once it settles.
  host.layoutChanged = (fn) => {
    const id = ++seq;
    pushes.set(id, () => safe(fn));
    fire("layoutChanged", [id]);
    return () => { if (pushes.delete(id)) fire("unwatch", [id]); };
  };
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
      // A row in the phone's More sheet may close it.
      if (init.slot === "mobile-more") host.more = { close: () => fire("more.close") };
      // Ten shapes a second at most, the latest winning: the host refuses faster, and a refused last shape would stay wrong.
      let hitAt = -1000, hitTimer = 0, hitNext = null, hitOpts = {};
      const sendHit = () => {
        hitTimer = 0;
        hitAt = Date.now();
        const shape = hitNext;
        hitNext = null;
        if (Array.isArray(shape)) return fire("hit.set", [shape, hitOpts]);
        const m = alphaMask(shape);
        fire("hit.set", [m, hitOpts], [m.alpha.buffer]);
      };
      host.hit = {
        set: (shape, fn, opts) => {
          activate = typeof fn === "function" ? fn : null;
          hitOpts = {};
          if (opts && typeof opts.label === "string") hitOpts.label = opts.label.slice(0, 120);
          if (opts && opts.focusable === true) hitOpts.focusable = true;
          hitNext = shape;
          if (!hitTimer) hitTimer = setTimeout(sendHit, Math.max(0, hitAt + 100 - Date.now()));
        },
      };
      if (has("runtime")) {
        if (port) host.runtime = runtimePort = port;
        else runtimeGone = true;
        host.runtimeGone = (fn) => {
          if (runtimeGone) { safe(fn); return quiet; }
          goneFns.add(fn);
          return () => { goneFns.delete(fn); };
        };
      } else if (port) host.runtime = port;
      // Esc in the sheet's frame never reaches the host's dialog: told here.
      if (init.slot === "sheet" && has("sheet")) document.addEventListener("keydown", (e) => { if (e.key === "Escape") fire("sheet.close"); });
      const box = document.createElement("div");
      box.id = "ikl-box";
      document.body.append(box);
      const off = mount(box, host);
      if (typeof off === "function") unmount = off;
      if (init.fit) fitHeight(box);
    }
    send({ t: "mounted" });
  } catch (e) {
    fail("mount", e);
  }
}

// The host's watchdog hears from every frame twice a second, with this frame's
// own long tasks since the last beat: frames share a process, so a late beat
// alone can't say whose loop stalled it.
let busy = 0;
try {
  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "self") busy += e.duration; }).observe({ type: "longtask" });
  }
} catch { /* not measured here: beats alone */ }
setInterval(() => { send({ t: "beat", busy: Math.min(60000, Math.round(busy)) }); busy = 0; }, 500);

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
  } else if (d.t === "runtime-gone") {
    runtimeIsGone();
  } else if (d.t === "unmount") {
    // The view is going: its cleanup runs now, and the host removes the frame once told (or past its deadline).
    const off = unmount;
    unmount = null;
    if (off) safe(off);
    send({ t: "unmounted" });
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
