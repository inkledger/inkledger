// Gitea's (and Forgejo's) webhook deliveries: the signature, the delivery id
// and the event, read from the raw request. The provider contract has no
// webhook operation yet (webhooks are the last provider work, D5): these are
// the pieces the receiving route will bind to it. Payloads are signals only.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Instant } from "@contracts/values";
import { instantFrom } from "@contracts/values";

/** Headers as a request gives them (names in any case). */
type Headers = Record<string, string | undefined> | { get(name: string): string | null };

const header = (h: Headers, name: string): string | null => {
  if ("get" in h && typeof h.get === "function") return h.get(name);
  const found = Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return typeof found?.[1] === "string" ? found[1] : null;
};

/** The signature a delivery carries: Gitea writes it in X-Gitea-Signature (Forgejo also X-Forgejo-Signature), a hex HMAC-SHA256 of the body, with no prefix. */
const signatureOf = (h: Headers) => header(h, "x-gitea-signature") ?? header(h, "x-forgejo-signature");

/** Whether the body (as received, byte for byte) was signed with the hook's secret. */
export function verifyWebhook(secret: string, rawBody: string | Uint8Array, headers: Headers): boolean {
  const given = signatureOf(headers)?.trim().toLowerCase();
  if (!given || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The delivery's id (a UUID, the same on a redelivery): what makes handling it idempotent. */
export const webhookDeliveryId = (headers: Headers): string | null => header(headers, "x-gitea-delivery") ?? header(headers, "x-forgejo-delivery");

/** The event name ("issues", "issue_comment"…). */
export const webhookEvent = (headers: Headers): string | null => header(headers, "x-gitea-event") ?? header(headers, "x-forgejo-event");

/** The canonical event an event name stands for (a signal: the issue is read again), or null for what the layer doesn't follow. */
export function canonicalWebhookEvent(event: string | null): "issueChanged" | "commentAdded" | null {
  if (event === "issues" || event === "issue_label" || event === "issue_assign" || event === "issue_milestone") return "issueChanged";
  if (event === "issue_comment") return "commentAdded";
  return null;
}

/** When the delivery says it was sent: deliveries carry no timestamp, so the change it reports is the best answer (null when unreadable). */
export function webhookSentAt(rawBody: string): Instant | null {
  try {
    const p = JSON.parse(rawBody) as { comment?: { updated_at?: string }; issue?: { updated_at?: string } };
    return instantFrom(p.comment?.updated_at ?? p.issue?.updated_at ?? null);
  } catch {
    return null;
  }
}

/** The webhook operations of this provider, as one object for the receiving route. */
export const giteaWebhook = {
  verify: verifyWebhook,
  deliveryId: webhookDeliveryId,
  event: webhookEvent,
  canonicalEvent: canonicalWebhookEvent,
  sentAt: webhookSentAt,
};
