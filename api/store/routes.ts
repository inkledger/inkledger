import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { STORE_PATH, type StoreItem } from "@contracts/store";
import { restUser } from "../context";
import { fetchCatalog } from "./client";
import { LruCache } from "../lib/lruCache";

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

/** A catalog picture, fetched once (requests for the same one at once share it); null when it isn't one we show. */
export async function fetchImage(url: string): Promise<Image | null> {
  return (
    (await storeImages.load(url, async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
      if (!res.ok || !IMAGE_TYPES.test(type)) return undefined;
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.byteLength > IMAGE_MAX_BYTES) return undefined;
      return { type, body };
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
