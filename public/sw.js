// inkledger service worker: makes the app installable and opens the anonymous
// shell when the server is briefly unreachable. API calls are never cached.
// Whenever a new shell arrives, /assets/* entries the new build no longer
// references are pruned, so old chunks don't pile up and errors never stick.
const CACHE = "inkledger-shell-v2";
const SHELL = "/offline.html";
const ASSET_REF = /\/?assets\/[\w.@~-]+/g;

const isHtml = (res) =>
  res.ok && (res.headers.get("content-type") ?? "").includes("text/html");

/** "/assets/x.js" paths mentioned in a text (HTML, JS chunk map, CSS url()). */
const refsIn = (text) =>
  new Set([...text.matchAll(ASSET_REF)].map(([m]) => (m.startsWith("/") ? m : `/${m}`)));

/**
 * Drop cached /assets/* not reachable from the given shell HTML. Follows the
 * JS/CSS it references (lazy route chunks and fonts are listed there, not in
 * the HTML), reading them from the cache or the network.
 */
async function prune(html) {
  const cache = await caches.open(CACHE);
  const keep = refsIn(html);
  const queue = [...keep].filter((p) => /\.(js|css)$/.test(p));
  for (let i = 0; i < queue.length && i < 200; i++) {
    const res = (await cache.match(queue[i])) ?? (await fetch(queue[i]).catch(() => null));
    if (!res || !res.ok) continue;
    for (const ref of refsIn(await res.text())) {
      if (keep.has(ref)) continue;
      keep.add(ref);
      if (/\.(js|css)$/.test(ref)) queue.push(ref);
    }
  }
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((req) => {
        const { pathname } = new URL(req.url);
        return pathname.startsWith("/assets/") && !keep.has(pathname);
      })
      .map((req) => cache.delete(req)),
  );
}

/** Store a fresh shell; prune assets only when it changed (= new build). */
async function storeShell(res) {
  const cache = await caches.open(CACHE);
  const html = await res.clone().text();
  const old = await cache.match(SHELL);
  const oldHtml = old ? await old.text() : null;
  await cache.put(SHELL, res);
  if (html !== oldHtml) await prune(html);
}

async function precacheShell() {
  const res = await fetch(SHELL, { cache: "no-store" });
  if (!isHtml(res)) throw new Error("offline shell unavailable");
  await storeShell(res);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    precacheShell()
      .then(() => caches.keys())
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Pages: network first, anonymous shell as fallback. Navigation HTML may
  // contain private SSR data and is never stored.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(SHELL).then((hit) => hit ?? Response.error()),
      ),
    );
    return;
  }

  // Hashed build assets: cache first (their names change on every build).
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              event.waitUntil(caches.open(CACHE).then((c) => c.put(request, copy)));
            }
            return res;
          }),
      ),
    );
  }
});
