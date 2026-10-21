// Redmine webhooks (to verify, SPIKES.md "redmine-webhook"): Redmine has no
// webhooks of its own. What the user sets up is a plugin (or a small hook of
// their own) that POSTs a JSON signal to inkledger with a shared secret in a
// header. This models that: the secret header, compared in constant time, and
// an id per delivery so a replay changes nothing. The body is only ever a
// signal (which issue changed): the adapter reads the issue again.
import { createHash } from "node:crypto";
import { sameSecret } from "../core/webhooks";
import type { WebhookRequest } from "../types";

/** The header the plugin sends the shared secret in (to verify). */
export const WEBHOOK_SECRET_HEADER = "x-inkledger-secret";
/** The header carrying a delivery id; absent, the id is a hash of the body. */
export const WEBHOOK_DELIVERY_HEADER = "x-inkledger-delivery";

/** Whether a delivery carries the connection's secret; a hook with no secret set is open to anyone, so never accepted. */
export function verifyRedmineWebhook(req: WebhookRequest, secret: string): boolean {
  const given = req.headers[WEBHOOK_SECRET_HEADER];
  return secret.length > 0 && !!given && sameSecret(given, secret);
}

/** The delivery's own id: the header, else a hash of the body (a retry repeats both). */
export function redmineDeliveryId(req: WebhookRequest): string | null {
  const given = req.headers[WEBHOOK_DELIVERY_HEADER];
  if (given) return given;
  return req.body ? createHash("sha256").update(req.body).digest("hex") : null;
}

/** When it was sent (epoch ms), when the body says so in a `timestamp` (seconds or milliseconds). */
export function redmineSentAt(req: WebhookRequest): number | null {
  try {
    const stamp = (JSON.parse(req.body) as { timestamp?: unknown }).timestamp;
    if (typeof stamp !== "number" || !Number.isFinite(stamp) || stamp <= 0) return null;
    return stamp < 1e11 ? Math.round(stamp * 1000) : Math.round(stamp);
  } catch {
    return null;
  }
}
