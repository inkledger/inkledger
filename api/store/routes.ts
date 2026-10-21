import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { STORE_PATH, type StoreItem } from "@contracts/store";
import { restUser } from "../context";
import { fetchCatalog } from "./client";

/**
 * Catalog pictures through this server: the page's CSP stays `img-src 'self'`
 * and the browser never calls the image host. Raster types only (an SVG from
 * our origin could run script), at most 2 MB, kept in memory (a few items).
 */

const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif|avif)$/;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const images = new Map<string, { type: string; body: Uint8Array<ArrayBuffer> }>();

async function fetchImage(url: string) {
  const hit = images.get(url);
  if (hit) return hit;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const type = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!res.ok || !IMAGE_TYPES.test(type)) return null;
  const body = new Uint8Array(await res.arrayBuffer());
  if (body.byteLength > IMAGE_MAX_BYTES) return null;
  const image = { type, body };
  images.set(url, image);
  return image;
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
