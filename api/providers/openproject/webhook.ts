// OpenProject's webhooks (to verify, SPIKES.md "openproject-webhook"): a
// webhook with a secret signs the body, `X-OP-Signature: sha1=<hex HMAC-SHA1>`;
// the body is `{ action: "work_package:updated", work_package: {...} }`. There
// is no delivery id or send time header: the id is a hash of the body (the
// payload carries the item's `updatedAt`, so a redelivery repeats it and a
// new change does not) and the time is the payload's own. A delivery is only
// ever a signal: the adapter reads the issue again.
import { createHash, createHmac } from "node:crypto";
import { sameSecret } from "../core/webhooks";

export const WEBHOOK_SIGNATURE_HEADER = "x-op-signature";

const header = (headers: Record<string, string | undefined>, name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1] ?? null;

/** `sha1=<hex>` of the body with the secret: what the header carries. */
export const signWebhook = (secret: string, body: string) => `sha1=${createHmac("sha1", secret).update(body, "utf8").digest("hex")}`;

/** Whether the body (as received, byte for byte) was signed with the webhook's secret. */
export function verifyOpenProjectWebhook(headers: Record<string, string | undefined>, body: string, secret: string): boolean {
  const given = header(headers, WEBHOOK_SIGNATURE_HEADER)?.trim().toLowerCase();
  if (!given || !secret || !/^sha1=[0-9a-f]{40}$/.test(given)) return false;
  return sameSecret(given, signWebhook(secret, body));
}

/** The delivery's id: a hash of the body (the same on a redelivery). */
export const openProjectDeliveryId = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

type Payload = {
  action?: unknown;
  work_package?: { updatedAt?: unknown };
  time_entry?: { updatedAt?: unknown };
  activity?: { createdAt?: unknown };
};

const parse = (body: string): Payload | null => {
  try {
    const p: unknown = JSON.parse(body);
    return p !== null && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
};

/** When the change happened, from the payload (epoch ms), or null when it says nothing readable. */
export function openProjectSentAt(body: string): number | null {
  const p = parse(body);
  const at = p?.activity?.createdAt ?? p?.time_entry?.updatedAt ?? p?.work_package?.updatedAt;
  const ms = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The declared event an action stands for, or null for what the layer doesn't follow (projects, news…). */
export function openProjectEvent(body: string): "issueChanged" | "commentAdded" | "worklogChanged" | null {
  const action = parse(body)?.action;
  if (action === "work_package:created" || action === "work_package:updated") return "issueChanged";
  if (action === "work_package_comment:comment") return "commentAdded";
  if (action === "time_entry:created" || action === "time_entry:updated") return "worklogChanged";
  return null;
}
