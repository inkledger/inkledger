// Webhooks (D5): a tracker tells a connection that something changed, and
// the connection reads its changes again sooner. Only an accelerator: the
// scheduled sync never relies on them, and a delivery is a signal, never
// data. Off by default (a server on a tailnet is rarely reachable); turned
// on per connection in Settings → Connections, which shows the address to
// register. Each delivery is checked: the connection's token in the URL, the
// service's signature (its adapter), no replay, not stale.
import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import type { TrackerType } from "@contracts/providers";
import { and, eq, isNull, lt } from "drizzle-orm";
import { connections, webhookDeliveries, type Connection } from "@db/schema";
import { getDb } from "./queries/connection";
import { openSecret } from "./lib/crypto";
import { hmacHex, sameSecret } from "./providers/core/webhooks";
import { trackerAdapter } from "./providers/registry";
import type { WebhookRequest } from "./providers/types";
import { syncConnectionEntries, syncConnectionIssues } from "./sync/engine";

/** A delivery sent longer ago than this is refused (replayed, or held somewhere). */
export const STALE_MS = 5 * 60_000;
/** Deliveries are coalesced: one read per connection at most this often. */
const DEBOUNCE_MS = 5_000;
/** Delivery ids are kept this long to refuse replays. */
const KEEP_DELIVERIES_MS = 2 * 86_400_000;

/** The token in a connection's webhook address: derived from its secret, so turning webhooks off and on again changes it. */
export const webhookToken = (secret: string, connectionId: number) => hmacHex(secret, `url:${connectionId}`).slice(0, 32);

/** The address to register on the service. */
export const webhookPath = (secret: string, connectionId: number) => `/api/hooks/${connectionId}/${webhookToken(secret, connectionId)}`;

const g = globalThis as { __iklHookTimers?: Map<number, NodeJS.Timeout> };
const timers = (g.__iklHookTimers ??= new Map<number, NodeJS.Timeout>());

/** The connection reads its changes soon (deliveries in a burst make one read). */
function readSoon(conn: Connection) {
  if (timers.has(conn.id)) return;
  timers.set(
    conn.id,
    setTimeout(() => {
      timers.delete(conn.id);
      void syncConnectionIssues(conn, { full: false, background: true })
        .then(() => syncConnectionEntries(conn, { full: false, background: true }))
        .catch((e: unknown) => console.warn(`[hooks] connection ${conn.id}: ${String(e)}`));
    }, DEBOUNCE_MS).unref(),
  );
}

export type HookOutcome = { status: 202 | 200 | 400 | 401 | 404; reason: string };

/** Checks one delivery and, when it is good, asks the connection to read again. */
export async function takeDelivery(connectionId: number, token: string, req: WebhookRequest, now = Date.now()): Promise<HookOutcome> {
  const db = getDb();
  const [conn] = await db
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), isNull(connections.archivedAt)))
    .limit(1);
  // Unknown, archived or off: the same answer, nothing told.
  if (!conn?.webhookSecret) return { status: 404, reason: "off" };
  const secret = openSecret(conn.webhookSecret, conn.id).plain;
  if (!sameSecret(token, webhookToken(secret, conn.id))) return { status: 404, reason: "off" };
  const check = trackerAdapter(conn.type as TrackerType)?.webhook;
  if (!check) return { status: 404, reason: "off" };
  if (!check.verify(req, secret)) return { status: 401, reason: "signature" };
  const sent = check.sentAt?.(req) ?? null;
  if (sent !== null && Math.abs(now - sent) > STALE_MS) return { status: 400, reason: "stale" };
  const delivery = check.deliveryId(req);
  if (delivery) {
    const fresh = await db
      .insert(webhookDeliveries)
      .values({ connectionId: conn.id, deliveryId: delivery.slice(0, 200), receivedAt: new Date(now) })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.deliveryId });
    // Already taken: fine for the service, nothing more to do.
    if (fresh.length === 0) return { status: 200, reason: "replay" };
  }
  readSoon(conn);
  return { status: 202, reason: "accepted" };
}

/** Delivery ids past the replay window go. */
export async function purgeWebhookDeliveries(now = Date.now()): Promise<number> {
  const gone = await getDb()
    .delete(webhookDeliveries)
    .where(lt(webhookDeliveries.receivedAt, new Date(now - KEEP_DELIVERIES_MS)))
    .returning({ id: webhookDeliveries.deliveryId });
  return gone.length;
}

export function registerHookRoutes(app: Hono<{ Bindings: HttpBindings }>) {
  app.post("/api/hooks/:id/:token", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false }, 404);
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const out = await takeDelivery(id, c.req.param("token"), { headers, body: await c.req.text() });
    return c.json({ ok: out.status < 300 }, out.status);
  });
}
