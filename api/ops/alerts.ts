// Alerts: a tracker connection that stopped working, a failed backup, a licence
// not renewed, an HTTPS certificate about to end. Raised where the change
// happens (no timer of their own), deduplicated per subject with a cooldown,
// then said three ways: an in-app notification (the connection's owner; admins
// for the server's own), the summary in Settings → Network, and an optional
// signed webhook (Slack, Teams or plain JSON).
import { randomBytes } from "node:crypto";
import { eq, isNull } from "drizzle-orm";
import { connections, connectionSync, notifications, users } from "@db/schema";
import { getDb } from "../queries/connection";
import { can, withAccessAll } from "../queries/accounts";
import { getServerSetting, setServerSetting, updateServerSetting } from "../lib/serverSettings";
import { openFor, sealFor } from "../lib/crypto";
import { hmacHex } from "../lib/secrets";
import { assertSafeUrl, type Network } from "../lib/security";
import { env } from "../lib/env";
import { certificateEnd, CERT_WARN_DAYS } from "../lib/tls";
import { safeFetch } from "../providers/core/http";
import { providerName } from "@contracts/providerNames";
import { t } from "@contracts/i18n";
import { noteAlert, noteWebhookFailure } from "./metrics";
import { opsConfig } from "./config";

export const ALERT_KINDS = ["auth_failed", "unreadable", "unreachable", "failures", "backup", "offsite", "drill", "licence", "certificate"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/**
 * What the alerts list (notifications of kind "alert", about no tracker) may hold besides
 * alerts: a feedback of one's own that moved or got an answer (feedback/store.ts). Never
 * raised, cooled down or sent to the webhook: written straight for its one reader.
 */
export const NOTICE_KINDS = [...ALERT_KINDS, "feedback"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** One alert: its subject (`key`, the unit of deduplication) and what it says. */
export type Alert = {
  key: string;
  kind: AlertKind;
  /** What it is about, as people call it: the connection's name, a licence's product. */
  name: string;
  connectionId?: number;
  /** The connection's owner (the one told in-app); none: the server's admins are. */
  userId?: number;
  /** Failures in a row (failures), days left (certificate). */
  count?: number;
};

/** In a notification's detail: enough to say it in the reader's language. */
export type AlertDetail = Pick<Alert, "kind" | "name" | "count">;

type Firing = Omit<Alert, "key"> & { since: number; notifiedAt: number };
type AlertState = { firing: Record<string, Firing>; sent: Record<string, number> };

const STATE_KEY = "alerts.state";
const WEBHOOK_KEY = "alerts.webhook";
const WEBHOOK_SCOPE = "alerts:webhook";
const EMPTY: AlertState = { firing: {}, sent: {} };

const cooldownMs = () => opsConfig.alertCooldownMin * 60_000;

/** The state as stored; anything unreadable counts as none. */
const stateOf = (raw: unknown): AlertState => {
  const s = raw as Partial<AlertState> | null;
  return { firing: s?.firing && typeof s.firing === "object" ? s.firing : {}, sent: s?.sent && typeof s.sent === "object" ? s.sent : {} };
};

/**
 * Records the alert as firing; true when it is to be told now: the first for its
 * subject, or the last one told is older than the cooldown (a connection that
 * flaps, or two streams failing in one pass, is told once). One step under the
 * setting's lock, so two raised at once never both send.
 */
export async function recordAlert(alert: Alert, now = Date.now()): Promise<boolean> {
  let tell = false;
  await updateServerSetting<AlertState>(STATE_KEY, EMPTY, (raw) => {
    const cur = stateOf(raw);
    const last = cur.sent[alert.key];
    tell = last === undefined || now - last >= cooldownMs();
    const prev = cur.firing[alert.key];
    const { key, ...rest } = alert;
    // What was told too long ago is forgotten: the state never grows past the live subjects.
    const sent = Object.fromEntries(Object.entries(cur.sent).filter(([, at]) => now - at < cooldownMs()));
    if (tell) sent[key] = now;
    return {
      firing: { ...cur.firing, [key]: { ...rest, since: prev?.since ?? now, notifiedAt: tell ? now : (prev?.notifiedAt ?? last ?? now) } },
      sent,
    };
  });
  return tell;
}

/** The subject works again: no longer in the summary (its cooldown still holds a relapse back). */
export async function resolveAlert(key: string): Promise<void> {
  const state = stateOf(await getServerSetting<unknown>(STATE_KEY, EMPTY));
  if (!(key in state.firing)) return;
  await updateServerSetting<AlertState>(STATE_KEY, EMPTY, (raw) => {
    const cur = stateOf(raw);
    return { ...cur, firing: Object.fromEntries(Object.entries(cur.firing).filter(([k]) => k !== key)) };
  });
}

/** Raises an alert: recorded, and when it is news, notified in-app and sent to the webhook. Never throws. */
export async function raiseAlert(alert: Alert, now = Date.now()): Promise<boolean> {
  try {
    if (!(await recordAlert(alert, now))) return false;
    noteAlert(alert.kind);
    console.warn(`[alerts] ${alert.kind}: ${alert.name}`);
    await notifyInApp(alert, now);
    await sendWebhook(alert).catch((e: unknown) => {
      noteWebhookFailure();
      console.warn(`[alerts] webhook not delivered: ${e instanceof Error ? e.message : String(e)}`);
    });
    return true;
  } catch (e) {
    console.warn(`[alerts] ${alert.key}: not raised (${e instanceof Error ? e.message : String(e)})`);
    return false;
  }
}

/** Who is told in-app: the connection's owner, else every account that runs the server. */
async function recipients(alert: Alert): Promise<number[]> {
  if (alert.userId !== undefined) return [alert.userId];
  const rows = await withAccessAll(await getDb().select().from(users).where(isNull(users.disabledAt)));
  return rows.filter((u) => can(u, "manageServer")).map((u) => u.id);
}

async function notifyInApp(alert: Alert, now: number): Promise<void> {
  const to = await recipients(alert);
  if (to.length === 0) return;
  const detail: AlertDetail = { kind: alert.kind, name: alert.name, ...(alert.count !== undefined ? { count: alert.count } : {}) };
  await getDb()
    .insert(notifications)
    .values(
      to.map((userId) => ({
        userId,
        connectionId: alert.connectionId ?? null,
        kind: "alert",
        issueKey: "",
        detail: JSON.stringify(detail),
        dedupe: `alert:${alert.key}:${now}`,
        createdAt: new Date(now),
      })),
    )
    .onConflictDoNothing({ target: [notifications.userId, notifications.dedupe] });
}

/** An alert in words (the server's language: a webhook has no reader's). */
export function alertText(a: AlertDetail): string {
  switch (a.kind) {
    case "auth_failed":
      return t("server.alerts.authFailed", { name: a.name });
    case "unreadable":
      return t("server.alerts.unreadable", { name: a.name });
    case "unreachable":
      return t("server.alerts.unreachable", { name: a.name });
    case "failures":
      return t("server.alerts.failures", { name: a.name, count: a.count ?? 0 });
    case "backup":
      return t("server.alerts.backup");
    case "offsite":
      return t("server.alerts.offsite");
    case "drill":
      return t("server.alerts.drill", { name: a.name });
    case "licence":
      return t("server.alerts.licence", { name: a.name });
    case "certificate":
      return (a.count ?? 0) <= 0 ? t("server.alerts.certificateExpired") : t("server.alerts.certificate", { count: a.count ?? 0 });
  }
}

// ── Webhook ────────────────────────────────────────────────────────────────

export const WEBHOOK_FORMATS = ["slack", "teams", "json"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];
type StoredWebhook = { url: string; secret: string; format: WebhookFormat };
export type Webhook = { url: string; secret: string; format: WebhookFormat };

/** Where an alert webhook may point: http(s), no credentials in it, never this server's neighbours or link-local/metadata addresses. */
export async function assertSafeWebhookUrl(url: string, resolve?: (host: string) => Promise<string[]>): Promise<void> {
  await assertSafeUrl(url, { network: "private", ...(resolve ? { resolve } : {}) });
}

export async function readWebhook(): Promise<Webhook | null> {
  const s = await getServerSetting<StoredWebhook | null>(WEBHOOK_KEY, null);
  if (!s?.url || !s.secret) return null;
  try {
    return { url: openFor(s.url, WEBHOOK_SCOPE), secret: openFor(s.secret, WEBHOOK_SCOPE), format: WEBHOOK_FORMATS.includes(s.format) ? s.format : "json" };
  } catch {
    return null;
  }
}

/** Saves the webhook (checked first); a new signing secret unless the URL stays and one exists. Null turns it off. */
export async function saveWebhook(input: { url: string; format: WebhookFormat } | null, opts: { resolve?: (host: string) => Promise<string[]> } = {}): Promise<Webhook | null> {
  if (!input) {
    await setServerSetting(WEBHOOK_KEY, null);
    return null;
  }
  await assertSafeWebhookUrl(input.url, opts.resolve);
  const current = await readWebhook();
  const secret = current?.url === input.url ? current.secret : randomBytes(32).toString("hex");
  await setServerSetting(WEBHOOK_KEY, { url: sealFor(input.url, WEBHOOK_SCOPE), secret: sealFor(secret, WEBHOOK_SCOPE), format: input.format } satisfies StoredWebhook);
  return { url: input.url, secret, format: input.format };
}

/** The body each chat service takes: Slack (and Mattermost, Rocket.Chat) a `text`, Teams workflows an Adaptive Card. */
export function webhookBody(alert: Alert, format: WebhookFormat, at: number): string {
  const text = alert.key === "test" ? t("server.alerts.test") : alertText(alert);
  const where = env.publicUrl ? `${env.publicUrl}/settings/network` : null;
  if (format === "slack") return JSON.stringify({ text: `inkledger: ${text}${where ? ` <${where}|${t("server.alerts.open")}>` : ""}` });
  if (format === "teams") {
    return JSON.stringify({
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.4",
            body: [
              { type: "TextBlock", text: "inkledger", weight: "Bolder" },
              { type: "TextBlock", text, wrap: true },
            ],
            ...(where ? { actions: [{ type: "Action.OpenUrl", title: t("server.alerts.open"), url: where }] } : {}),
          },
        },
      ],
    });
  }
  return JSON.stringify({ event: "alert", kind: alert.kind, subject: alert.key, name: alert.name, ...(alert.count !== undefined ? { count: alert.count } : {}), text, at: new Date(at).toISOString(), ...(where ? { url: where } : {}) });
}

/** Signature headers: HMAC-SHA256 of "<timestamp>.<body>" with the webhook's secret. */
export function signatureHeaders(secret: string, body: string, at: number): Record<string, string> {
  const ts = String(Math.floor(at / 1000));
  return { "X-Inkledger-Timestamp": ts, "X-Inkledger-Signature": `sha256=${hmacHex(secret, `${ts}.${body}`)}` };
}

const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Posts the alert to the webhook, if one is set. Checked again before each call
 * (DNS may have changed since it was saved), connected only to allowed addresses,
 * redirects to another origin refused. A read-only server (a test server on a
 * copied database) sends nothing.
 */
export async function sendWebhook(alert: Alert, o: { now?: number; network?: Network; fetchImpl?: typeof safeFetch } = {}): Promise<boolean> {
  const hook = await readWebhook();
  if (!hook) return false;
  if (env.readOnly) {
    console.warn("[alerts] webhook not sent: read-only server");
    return false;
  }
  const network = o.network ?? "private";
  await assertSafeUrl(hook.url, { network });
  const at = o.now ?? Date.now();
  const body = webhookBody(alert, hook.format, at);
  const res = await (o.fetchImpl ?? safeFetch)({
    site: new URL(hook.url).origin,
    url: hook.url,
    network,
    init: { method: "POST", body, headers: { "Content-Type": "application/json", ...signatureHeaders(hook.secret, body, at) }, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) },
    fail: (_status, message) => new Error(message),
  });
  await res.body?.cancel().catch(() => undefined);
  if (!res.ok) throw new Error(`${new URL(hook.url).host} answered ${res.status}`);
  return true;
}

/** A test message from Settings, through the same path (cooldown aside). */
export async function testWebhook(): Promise<void> {
  const hook = await readWebhook();
  if (!hook) throw new Error(t("server.alerts.noWebhook"));
  // Not "sent" when nothing went: a read-only server posts nothing, the test says so.
  if (!(await sendWebhook({ key: "test", kind: "backup", name: "test" }))) throw new Error(t("server.alerts.readOnly"));
}

// ── Where alerts come from ─────────────────────────────────────────────────

type ConnRow = { id: number; userId: number; type: string; label: string };

const connectionName = (c: Pick<ConnRow, "type" | "label">) => c.label || providerName(c.type);

/** A connection stopped working (refused or unreadable credentials, out of reach) or keeps failing. */
export async function connectionAlert(conn: ConnRow, kind: Extract<AlertKind, "auth_failed" | "unreadable" | "unreachable" | "failures">, count?: number): Promise<boolean> {
  return raiseAlert({ key: `connection:${conn.id}`, kind, name: connectionName(conn), connectionId: conn.id, userId: conn.userId, ...(count !== undefined ? { count } : {}) });
}

/** Same, from the connection's id (the failure paths know only that). */
export async function connectionAlertById(connectionId: number, kind: Parameters<typeof connectionAlert>[1], count?: number): Promise<boolean> {
  const [conn] = await getDb()
    .select({ id: connections.id, userId: connections.userId, type: connections.type, label: connections.label })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);
  return conn ? connectionAlert(conn, kind, count) : false;
}

export async function backupFailed(): Promise<void> {
  await raiseAlert({ key: "backup", kind: "backup", name: "backup" });
}

export async function backupSucceeded(): Promise<void> {
  await resolveAlert("backup").catch(() => undefined);
}

/** Licence renewals: one refused or out of reach is told ("off": no store, nothing to renew); one renewed clears it. */
export async function licenceRenewals(results: { id: string; product?: string; ok: boolean; reason?: string }[]): Promise<void> {
  for (const r of results) {
    const key = `licence:${r.id.slice(0, 12)}`;
    if (r.ok) await resolveAlert(key).catch(() => undefined);
    else if (r.reason !== "off") await raiseAlert({ key, kind: "licence", name: r.product ?? r.id.slice(0, 6) });
  }
}

let certificateLookedAt = 0;
const DAY_MS = 86_400_000;

/** The HTTPS certificate's end, looked at most daily (after a sync pass, and at start): told within CERT_WARN_DAYS of it. */
export async function certificateCheck(o: { dir?: string | null; now?: number; force?: boolean } = {}): Promise<void> {
  const now = o.now ?? Date.now();
  const dir = o.dir !== undefined ? o.dir : env.tlsDir;
  if (!dir || (!o.force && now - certificateLookedAt < DAY_MS)) return;
  certificateLookedAt = now;
  const end = certificateEnd(dir);
  if (!end) return;
  const days = Math.ceil((end.getTime() - now) / DAY_MS);
  if (days > CERT_WARN_DAYS) await resolveAlert("certificate");
  else await raiseAlert({ key: "certificate", kind: "certificate", name: "https", count: days }, now);
}

// ── Summary (Settings → Network) ───────────────────────────────────────────

export type AlertSummary = { key: string; kind: AlertKind; name: string; count: number | null; since: number; notifiedAt: number; connectionId: number | null };

/**
 * What is firing now. A connection's alert whose connection works again
 * (reconnected, or synced since) or is gone leaves the list here: recovery has
 * many ways in, the summary checks the connection itself.
 */
export async function alertSummary(): Promise<AlertSummary[]> {
  const state = stateOf(await getServerSetting<unknown>(STATE_KEY, EMPTY));
  const out: AlertSummary[] = [];
  const stale: string[] = [];
  for (const [key, f] of Object.entries(state.firing)) {
    if (f.connectionId !== undefined) {
      const [conn] = await getDb().select({ status: connections.status, archivedAt: connections.archivedAt }).from(connections).where(eq(connections.id, f.connectionId)).limit(1);
      const failing = conn
        ? (await getDb().select({ failures: connectionSync.failures }).from(connectionSync).where(eq(connectionSync.connectionId, f.connectionId))).some((s) => s.failures >= opsConfig.alertFailures)
        : false;
      if (!conn || conn.archivedAt !== null || (conn.status === "ok" && !failing)) {
        stale.push(key);
        continue;
      }
    }
    out.push({ key, kind: f.kind, name: f.name, count: f.count ?? null, since: f.since, notifiedAt: f.notifiedAt, connectionId: f.connectionId ?? null });
  }
  for (const key of stale) await resolveAlert(key);
  return out.sort((a, b) => b.since - a.since);
}

/** Test helper: forget every alert and the certificate's last look. */
export async function resetAlertsForTests(): Promise<void> {
  certificateLookedAt = 0;
  await setServerSetting(STATE_KEY, EMPTY);
}

