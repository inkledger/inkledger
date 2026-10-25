import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { STORE_PATH, type StoreItem } from "@contracts/store";
import { restUser } from "../context";
import { fetchCatalog } from "./client";
import { LruCache } from "../lib/lruCache";
import { env } from "../lib/env";
import { safeFetch } from "../providers/core/http";

/**
 * Catalog pictures through this server: the page's CSP stays `img-src 'self'`
 * and the browser never calls the image host. Raster types only (an SVG from
 * our origin could run script), at most 2 MB each, kept in memory within a cap
 * (a catalog renewed for months must not grow it without end).
 */

const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif|avif)$/;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
type Image = { type: string; body: Uint8Array<ArrayBuffer> };
/** The pictures kept: the most recently shown, 32 MB and 64 at most. */
export const storeImages = new LruCache<string, Image>({ maxEntries: 64, maxSize: 32 * 1024 * 1024, sizeOf: (i) => i.body.byteLength });

/**
 * A picture's request. On the store's own origin (STORE_URL, the operator's choice: a
 * self-hosted store may live on the LAN) as is, no redirect followed; anywhere else
 * only https on a public host, its redirects followed by hand and checked again
 * (safeFetch): a catalog entry must never make this server call an internal address.
 */
async function requestPicture(url: string, signal: AbortSignal): Promise<Response | null> {
  const target = new URL(url);
  if (env.storeUrl && target.origin === new URL(env.storeUrl).origin) {
    const res = await fetch(target, { signal, redirect: "manual" });
    return res.status >= 300 && res.status < 400 ? null : res;
  }
  if (target.protocol !== "https:") return null;
  return safeFetch({ site: target.origin, url: target.toString(), init: { signal }, intent: "read", allowCrossOrigin: true, fail: (_, message) => new Error(message) });
}

/** The body, read up to `max` bytes: null past it (a declared length too big is refused before any byte). */
async function readCapped(res: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return body;
}

/** A catalog picture, fetched once (requests for the same one at once share it); null when it isn't one we show. */
export async function fetchImage(url: string): Promise<Image | null> {
  return (
    (await storeImages.load(url, async () => {
      const res = await requestPicture(url, AbortSignal.timeout(8000));
      if (!res) return undefined;
      const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      if (!res.ok || !IMAGE_TYPES.test(type)) {
        await res.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const body = await readCapped(res, IMAGE_MAX_BYTES);
      return body ? { type, body } : undefined;
    })) ?? null
  );
}

/** The catalog URL behind a media slot: image, hero or a gallery index. */
function sourceOf(item: StoreItem, slot: string): string | undefined {
  if (slot === "image") return item.image;
  if (slot === "hero") return item.hero;
  return /^\d$/.test(slot) ? item.gallery?.[Number(slot)]?.src : undefined;
}

export function registerStoreRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  app.get(`${STORE_PATH}/media/:id/:slot`, async (c) => {
    const who = await restUser(c.req.raw);
    if (!("user" in who)) return c.json({ error: who.error }, who.status);
    try {
      const item = (await fetchCatalog()).find((i) => i.id === c.req.param("id"));
      const src = item ? sourceOf(item, c.req.param("slot")) : undefined;
      const image = src ? await fetchImage(src) : null;
      if (!image) return c.json({ error: "Not Found" }, 404);
      return c.body(image.body, 200, {
        "Content-Type": image.type,
        "Cache-Control": "private, max-age=43200",
        "X-Content-Type-Options": "nosniff",
      });
    } catch {
      return c.json({ error: "Not Found" }, 404);
    }
  });
}
