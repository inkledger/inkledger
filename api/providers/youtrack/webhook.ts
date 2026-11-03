// YouTrack webhooks (to verify, docs/dev/spikes.md "youtrack-webhook"): YouTrack
// has no signed webhooks of its own. What the user sets up is a workflow
// (a rule using the `http` module) or an app that POSTs a small JSON signal to
// inkledger with a shared secret in a header. This models that: the secret
// header, compared in constant time, and an id per delivery so a replay
// changes nothing. The body is only ever a signal (which issue changed): the
// adapter reads the issue again.
import { sha256Hex } from "../../lib/hash";
import { headerOf, sameSecretHashed } from "../core/webhooks";
import { instant, type Instant } from "@contracts/values";

/** The header the workflow sends the shared secret in (to verify). */
export const WEBHOOK_SECRET_HEADER = "x-inkledger-secret";
/** The header carrying a delivery id; absent, the id is a hash of the body. */
export const WEBHOOK_DELIVERY_HEADER = "x-inkledger-delivery";

export type WebhookCheck = { ok: true; deliveryId: string; sentAt?: Instant } | { ok: false; reason: "noSecret" | "wrongSecret" };

/** Whether a delivery carries the connection's secret; its id and, when the body says it, when it was sent. */
export function verifyYouTrackWebhook(headers: Headers | Record<string, string | undefined>, rawBody: string, secret: string): WebhookCheck {
  const given = headerOf(headers, WEBHOOK_SECRET_HEADER);
  if (!given || !secret) return { ok: false, reason: "noSecret" };
  if (!sameSecretHashed(given, secret)) return { ok: false, reason: "wrongSecret" };
  const deliveryId = headerOf(headers, WEBHOOK_DELIVERY_HEADER) || sha256Hex(rawBody);
  let sentAt: Instant | undefined;
  try {
    const stamp = (JSON.parse(rawBody) as { timestamp?: unknown }).timestamp;
    if (typeof stamp === "number" && Number.isFinite(stamp)) sentAt = instant(stamp);
  } catch {
    // a body that isn't JSON is still a signal
  }
  return { ok: true, deliveryId, ...(sentAt !== undefined ? { sentAt } : {}) };
}
