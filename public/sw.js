// inkledger service worker: makes the app installable and opens the shell when
// the server is briefly unreachable. API calls are never cached.
//
// The cache name stays fixed (this file is not rebuilt per deploy); instead,
// whenever a new shell arrives, /assets/* entries the new build no longer
// references are pruned, so old chunks don't pile up and errors never stick.
const CACHE = "inkledger-shell-v1";
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
  const old = await cache.match("/");
  const oldHtml = old ? await old.text() : null;
  await cache.put("/", res);
  if (html !== oldHtml) await prune(html);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    fetch("/")
      .then((res) => (isHtml(res) ? storeShell(res) : undefined))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => fetch("/", { cache: "no-store" }))
      .then((res) => (isHtml(res) ? res.text().then(prune) : undefined))
      .catch(() => undefined) // offline: prune on the next navigation
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // Pages: network first, cached shell as fallback. Only real HTML pages are
  // stored, never an error page or a proxy's 502.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (isHtml(res)) event.waitUntil(storeShell(res.clone()).catch(() => undefined));
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? Response.error())),
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
