// Signing in to a Microsoft mailbox and searching it (Graph, Mail.Read), to pin
// a mail by searching for it instead of copying anything out of Outlook. The
// sign-in is the device code flow, as GitHub's: inkledger asks Microsoft for a
// code, the user enters it on microsoft.com, inkledger waits for the tokens. No
// redirect reaches inkledger, which suits a server on a private address. Only
// headers are ever read, never a body. Pending sign-ins live in this process.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "../lib/env";
import { openFor, sealFor } from "../lib/crypto";
import { getDb } from "../queries/connection";
import { mailAccounts } from "@db/schema";
import { safeFetch } from "../providers/core/http";
import { ProviderError, kindOfStatus } from "../providers/core/errors";
import { messageId, outlookDeeplink } from "@contracts/mail";
import { simulatedMicrosoft } from "./simulator";
import { t } from "@contracts/i18n";

const LOGIN = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";
/** What inkledger asks for: reading mail (headers only are used), staying signed in, who is signed in. */
export const MAIL_SCOPES = "Mail.Read offline_access User.Read";

/** Microsoft's answers that mean the organization must approve the app first. */
const CONSENT_CODES = /AADSTS(65001|65004|90094|900941|90095)\b/;

export type MailTokens = { v: 1; accessToken: string; expiresAt: number; refreshToken: string | null };

type TokenAnswer = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
};

/** A mail read from the mailbox, ready for mails.save. */
export type FoundMail = {
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: number | null;
  webLink: string | null;
  internetMessageId: string | null;
  exchangeId: string | null;
  source: "graph";
};

/** A Graph message, as much of it as is asked for ($select). */
type GraphMessage = {
  id: string;
  subject?: string | null;
  from?: { emailAddress?: { name?: string | null; address?: string | null } } | null;
  receivedDateTime?: string | null;
  internetMessageId?: string | null;
  webLink?: string | null;
};
const SELECT = "id,subject,from,receivedDateTime,internetMessageId,webLink";

const fail = (status: number, message: string) => new ProviderError(status === 403 ? "readOnly" : "invalid", message, { status });

/** One call to Microsoft: the real one, or the simulator under the tests. */
async function call(url: string, init: RequestInit): Promise<Response> {
  if (env.mailSimulator) return simulatedMicrosoft(url, init);
  // Signing in and reading change nothing: allowed on a read-only server too.
  return safeFetch({ site: new URL(url).origin, url, init, intent: "read", network: "public", fail });
}

function clientId(): string {
  if (!env.microsoftClientId && !env.mailSimulator) throw new ProviderError("incompatible", t("server.mails.notConfigured"));
  return env.microsoftClientId ?? "simulated";
}

const tenantUrl = (path: string) => `${LOGIN}/${encodeURIComponent(env.microsoftTenant)}/oauth2/v2.0/${path}`;

async function postForm(path: string, form: Record<string, string>): Promise<{ status: number; body: TokenAnswer & Record<string, unknown> }> {
  const res = await call(tenantUrl(path), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as TokenAnswer & Record<string, unknown>;
  // A 400 carries the flow's state (pending, declined…); anything else is Microsoft busy or down.
  if (!res.ok && res.status !== 400) {
    const kind = kindOfStatus(res.status);
    throw new ProviderError(kind === "auth" ? "invalid" : kind, `Microsoft answered ${res.status}`, { status: res.status });
  }
  return { status: res.status, body };
}

const tokensOf = (r: TokenAnswer, previous: string | null = null, now = Date.now()): MailTokens => ({
  v: 1,
  accessToken: r.access_token ?? "",
  expiresAt: now + Math.max(60, r.expires_in ?? 3600) * 1000,
  // Microsoft may answer a refresh without a new refresh token: the old one stays good.
  refreshToken: r.refresh_token ?? previous,
});

type Flow = { userId: number; deviceCode: string; intervalMs: number; nextAt: number; expiresAt: number };
const flows = new Map<string, Flow>();

/** A new sign-in: the code to enter at Microsoft, and where. */
export async function startMailLogin(userId: number) {
  const { status, body } = await postForm("devicecode", { client_id: clientId(), scope: MAIL_SCOPES });
  if (status !== 200) throw new ProviderError(consentNeeded(body) ? "forbidden" : "invalid", consentNeeded(body) ? t("server.mails.consent") : t("server.mails.loginRefused", { reason: body.error_description?.split("\r\n")[0] ?? `HTTP ${status}` }));
  const r = body as unknown as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };
  const id = randomUUID();
  const now = Date.now();
  const interval = Math.max(5, r.interval ?? 5);
  flows.set(id, { userId, deviceCode: r.device_code, intervalMs: interval * 1000, nextAt: now, expiresAt: now + r.expires_in * 1000 });
  for (const [k, f] of flows) if (f.expiresAt < now) flows.delete(k);
  return { flowId: id, userCode: r.user_code, verificationUri: r.verification_uri, intervalSeconds: interval, expiresIn: r.expires_in };
}

const consentNeeded = (r: TokenAnswer) => CONSENT_CODES.test(r.error_description ?? "") || r.error === "consent_required";

export type MailLoginResult =
  | { state: "pending"; retryInSeconds: number }
  | { state: "failed"; reason: "denied" | "expired" | "consent" }
  | { state: "authorized"; account: string; displayName: string | null };

/** Asks Microsoft once whether the user signed in (never faster than it allows); signed in, the account is kept. */
export async function pollMailLogin(userId: number, flowId: string): Promise<MailLoginResult> {
  const f = flows.get(flowId);
  if (!f || f.userId !== userId || f.expiresAt < Date.now()) {
    flows.delete(flowId);
    return { state: "failed", reason: "expired" };
  }
  if (Date.now() < f.nextAt) return { state: "pending", retryInSeconds: Math.ceil((f.nextAt - Date.now()) / 1000) };
  const { body } = await postForm("token", {
    client_id: clientId(),
    device_code: f.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (body.access_token) {
    flows.delete(flowId);
    const tokens = tokensOf(body);
    const me = await graphGet<{ userPrincipalName?: string; mail?: string | null; displayName?: string | null }>(tokens, "/me?$select=userPrincipalName,mail,displayName");
    const account = me.userPrincipalName ?? me.mail ?? "";
    await storeTokens(userId, tokens, { account, displayName: me.displayName ?? null });
    return { state: "authorized", account, displayName: me.displayName ?? null };
  }
  if (body.error === "slow_down") f.intervalMs += 5000;
  if (body.error === "authorization_pending" || body.error === "slow_down") {
    f.nextAt = Date.now() + f.intervalMs;
    return { state: "pending", retryInSeconds: Math.ceil(f.intervalMs / 1000) };
  }
  flows.delete(flowId);
  if (consentNeeded(body)) return { state: "failed", reason: "consent" };
  return { state: "failed", reason: body.error === "authorization_declined" || body.error === "access_denied" ? "denied" : "expired" };
}

const scopeOf = (userId: number) => `mail:${userId}`;

async function storeTokens(userId: number, tokens: MailTokens, who?: { account: string; displayName: string | null }): Promise<void> {
  const secret = sealFor(JSON.stringify(tokens), scopeOf(userId));
  const now = new Date();
  if (who)
    await getDb()
      .insert(mailAccounts)
      .values({ userId, ...who, secret, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: mailAccounts.userId, set: { ...who, secret, updatedAt: now } });
  else await getDb().update(mailAccounts).set({ secret, updatedAt: now }).where(eq(mailAccounts.userId, userId));
}

/** Who is signed in, if anyone. */
export async function mailAccount(userId: number): Promise<{ account: string; displayName: string | null } | null> {
  const [row] = await getDb().select({ account: mailAccounts.account, displayName: mailAccounts.displayName }).from(mailAccounts).where(eq(mailAccounts.userId, userId));
  return row ?? null;
}

export async function signOutMail(userId: number): Promise<void> {
  await getDb().delete(mailAccounts).where(eq(mailAccounts.userId, userId));
}

/** The signed-in user's tokens, renewed when the access token runs out (null: not signed in). */
async function tokensFor(userId: number): Promise<MailTokens | null> {
  const [row] = await getDb().select({ secret: mailAccounts.secret }).from(mailAccounts).where(eq(mailAccounts.userId, userId));
  if (!row) return null;
  const tokens = JSON.parse(openFor(row.secret, scopeOf(userId))) as MailTokens;
  return tokens.expiresAt - 60_000 > Date.now() ? tokens : renew(userId, tokens);
}

async function renew(userId: number, tokens: MailTokens): Promise<MailTokens> {
  if (!tokens.refreshToken) throw new ProviderError("auth", t("server.mails.signedOut"));
  const { body } = await postForm("token", {
    client_id: clientId(),
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    scope: MAIL_SCOPES,
  });
  if (!body.access_token) {
    // Revoked, or the password changed: signed out, the next search asks to sign in again.
    await signOutMail(userId);
    throw new ProviderError("auth", consentNeeded(body) ? t("server.mails.consent") : t("server.mails.signedOut"));
  }
  const next = tokensOf(body, tokens.refreshToken);
  await storeTokens(userId, next);
  return next;
}

async function graphGet<T>(tokens: MailTokens, path: string): Promise<T> {
  const res = await call(`${GRAPH}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${tokens.accessToken}`,
      // Ids that survive a move to another folder: links kept on a pin stay good.
      Prefer: 'IdType="ImmutableId"',
    },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    const kind = kindOfStatus(res.status);
    throw new ProviderError(kind, `Microsoft Graph answered ${res.status}`, { status: res.status });
  }
  return (await res.json()) as T;
}

/** A call on the user's behalf: renewed once on a 401 (an access token revoked early). */
async function asUser<T>(userId: number, path: string): Promise<T | null> {
  const tokens = await tokensFor(userId);
  if (!tokens) return null;
  try {
    return await graphGet<T>(tokens, path);
  } catch (e) {
    if (!(e instanceof ProviderError) || e.kind !== "auth") throw e;
    return graphGet<T>(await renew(userId, tokens), path);
  }
}

export const foundMail = (m: GraphMessage): FoundMail => ({
  subject: (m.subject ?? "").trim(),
  fromName: m.from?.emailAddress?.name?.trim() || null,
  fromAddress: m.from?.emailAddress?.address?.trim().toLowerCase() || null,
  receivedAt: m.receivedDateTime ? Date.parse(m.receivedDateTime) || null : null,
  // Graph's own link opens the mail in Outlook on the web; else the deeplink of its id.
  webLink: m.webLink || outlookDeeplink(m.id),
  internetMessageId: messageId(m.internetMessageId ?? undefined),
  exchangeId: m.id,
  source: "graph",
});

/** Graph's search wants a quoted phrase: quotes inside are dropped. */
const searchTerm = (q: string) => `"${q.replace(/["\\]/g, " ").trim()}"`;

/**
 * The mails matching `query` in the whole mailbox, or the inbox's latest when
 * there is none. Null when nobody is signed in.
 */
export async function searchMailbox(userId: number, query?: string): Promise<FoundMail[] | null> {
  const q = query?.trim();
  const path = q
    ? `/me/messages?$search=${encodeURIComponent(searchTerm(q))}&$select=${SELECT}&$top=25`
    : `/me/mailFolders/inbox/messages?$orderby=receivedDateTime%20desc&$select=${SELECT}&$top=25`;
  const r = await asUser<{ value: GraphMessage[] }>(userId, path);
  return r ? r.value.map(foundMail) : null;
}

/** The mail with this Message-ID in the mailbox (to give a mail from a file its link), if signed in and found. */
export async function findByMessageId(userId: number, id: string): Promise<FoundMail | null> {
  const value = `<${id.replace(/^<|>$/g, "")}>`.replace(/'/g, "''");
  const r = await asUser<{ value: GraphMessage[] }>(userId, `/me/messages?$filter=${encodeURIComponent(`internetMessageId eq '${value}'`)}&$select=${SELECT}&$top=1`);
  return r?.value[0] ? foundMail(r.value[0]) : null;
}
