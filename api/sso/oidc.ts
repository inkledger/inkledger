// OpenID Connect sign-in: the authorization code flow with PKCE, state and nonce. The ID
// token's claims are checked by oauth4webapi (iss, aud, exp, nonce, azp) and its signature
// against the provider's keys (JWKS, cached) by jose; Entra ID's tenant (tid) too when one is set.
import * as oauth from "oauth4webapi";
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import type { IdentityProvider } from "@db/schema";
import { assertSafeUrl } from "../lib/security";
import { env } from "../lib/env";
import { claimMapOf, clientSecretOf, saveState, takeState, type SsoState, type StateInput } from "./store";
import { spUrls } from "./urls";
import type { Identity } from "./accounts";

/** Why a sign-in failed, as the callback tells it (the login page words it). */
export class SsoError extends Error {
  readonly failure: "unavailable" | "notConfigured" | "expired" | "refused" | "invalid";
  constructor(failure: SsoError["failure"], detail: string) {
    super(detail);
    this.failure = failure;
    this.name = "SsoError";
  }
}

const CACHE_MS = 60 * 60_000;
const TIMEOUT_MS = 10_000;
/** Seconds of clock difference with the provider tolerated on the token's times. */
export const CLOCK_TOLERANCE_S = 120;

/** An address of the provider the server may call: https on a public or company network; plain http on this machine only for the tests' simulator. */
export async function assertIdpUrl(raw: string): Promise<void> {
  const url = new URL(raw);
  if (env.ssoAllowLocalIdp && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return;
  if (url.protocol !== "https:") throw new SsoError("notConfigured", `${url.origin}: identity providers are reached over https only`);
  await assertSafeUrl(raw, { network: "private" });
}

/** A call to the provider: checked first, bounded in time, no redirect followed. */
export async function idpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  await assertIdpUrl(url);
  return fetch(url, { ...init, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
}

const insecure = (raw: string) => env.ssoAllowLocalIdp && new URL(raw).protocol === "http:";
const fetchOptions = (raw: string) => ({ [oauth.customFetch]: (url: string, o: oauth.CustomFetchOptions<string, unknown>) => idpFetch(url, o as RequestInit), [oauth.allowInsecureRequests]: insecure(raw) });

const servers = new Map<number, { key: string; as: oauth.AuthorizationServer; at: number }>();
const keySets = new Map<string, { jwks: JSONWebKeySet; at: number }>();

/** Forgets what was read of a provider (its settings changed). */
export function forgetProvider(id: number): void {
  servers.delete(id);
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * The provider's configuration (discovery, cached an hour). Its issuer must be the one
 * configured, or, for Entra ID's multi-tenant endpoints ("{tenantid}"), that with the one
 * tenant set: anything else is someone else's configuration.
 */
export async function serverOf(p: IdentityProvider): Promise<oauth.AuthorizationServer> {
  const where = p.discoveryUrl || `${p.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const key = `${where}|${p.issuer}|${p.tenantId ?? ""}`;
  const cached = servers.get(p.id);
  if (cached && cached.key === key && Date.now() - cached.at < CACHE_MS) return cached.as;
  let doc: Record<string, unknown>;
  try {
    const res = await idpFetch(where, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`discovery answered ${res.status}`);
    doc = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof SsoError) throw e;
    throw new SsoError("unavailable", `${where}: ${String(e)}`);
  }
  if (!str(doc.issuer) || !str(doc.authorization_endpoint) || !str(doc.token_endpoint) || !str(doc.jwks_uri)) throw new SsoError("notConfigured", `${where}: not an OpenID configuration`);
  let issuer = doc.issuer;
  if (issuer.includes("{tenantid}")) {
    if (!p.tenantId) throw new SsoError("notConfigured", "a multi-tenant Entra ID endpoint needs the tenant id");
    issuer = issuer.replace("{tenantid}", p.tenantId);
  } else if (issuer !== p.issuer) {
    throw new SsoError("notConfigured", `the configuration's issuer ${issuer} is not ${p.issuer}`);
  }
  for (const u of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri]) await assertIdpUrl(u);
  const as = { ...(doc as Omit<oauth.AuthorizationServer, "issuer">), issuer } satisfies oauth.AuthorizationServer;
  servers.set(p.id, { key, as, at: Date.now() });
  return as;
}

async function keySet(uri: string, fresh: boolean): Promise<JSONWebKeySet> {
  const cached = keySets.get(uri);
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.jwks;
  const res = await idpFetch(uri, { headers: { accept: "application/json" } });
  if (!res.ok) throw new SsoError("unavailable", `keys answered ${res.status}`);
  const jwks = (await res.json()) as JSONWebKeySet;
  if (!Array.isArray(jwks.keys)) throw new SsoError("unavailable", "no keys");
  keySets.set(uri, { jwks, at: Date.now() });
  return jwks;
}

/** The ID token's signature, by the provider's keys (fetched again once for a key not known yet: a rotation). */
export async function verifyIdTokenSignature(as: oauth.AuthorizationServer, idToken: string, clientId: string): Promise<JWTPayload> {
  const uri = as.jwks_uri;
  if (!uri) throw new SsoError("notConfigured", "no jwks_uri");
  const opts = { issuer: as.issuer, audience: clientId, clockTolerance: CLOCK_TOLERANCE_S, algorithms: ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"] };
  try {
    return (await jwtVerify(idToken, createLocalJWKSet(await keySet(uri, false)), opts)).payload;
  } catch (e) {
    if (!(e instanceof joseErrors.JWKSNoMatchingKey)) throw new SsoError("invalid", `ID token: ${String(e)}`);
  }
  try {
    return (await jwtVerify(idToken, createLocalJWKSet(await keySet(uri, true)), opts)).payload;
  } catch (e) {
    throw new SsoError("invalid", `ID token: ${String(e)}`);
  }
}

const client = (p: IdentityProvider): oauth.Client => ({ client_id: p.clientId, [oauth.clockTolerance]: CLOCK_TOLERANCE_S });

function clientAuth(p: IdentityProvider, as: oauth.AuthorizationServer): oauth.ClientAuth {
  const secret = clientSecretOf(p);
  if (!secret) return oauth.None();
  const methods = as.token_endpoint_auth_methods_supported;
  return methods && !methods.includes("client_secret_basic") && methods.includes("client_secret_post") ? oauth.ClientSecretPost(secret) : oauth.ClientSecretBasic(secret);
}

/** Where the browser goes to sign in, and the state its cookie binds this browser to. */
export async function oidcStart(p: IdentityProvider, s: Omit<StateInput, "nonce" | "pkceVerifier">): Promise<{ url: string; state: string }> {
  const urls = spUrls(p.id);
  if (!urls) throw new SsoError("notConfigured", "PUBLIC_URL is not set");
  const as = await serverOf(p);
  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const pkceVerifier = oauth.generateRandomCodeVerifier();
  await saveState("oidc", state, p.id, { ...s, nonce, pkceVerifier });
  const url = new URL(as.authorization_endpoint ?? "");
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", urls.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", p.scopes || "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", await oauth.calculatePKCECodeChallenge(pkceVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.href, state };
}

const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter(Boolean) : typeof v === "string" && v ? [v] : []);

/** What the ID token says about the person, through the provider's claim map. */
export function identityFromClaims(p: Pick<IdentityProvider, "claimMap">, claims: Record<string, unknown>): Identity {
  const m = claimMapOf(p);
  const email = text(claims[m.email || "email"]);
  return {
    subject: text(claims[m.subject || "sub"]),
    username: text(claims[m.username || "preferred_username"]) || email,
    email,
    name: text(claims[m.name || "name"]),
    groups: list(claims[m.groups || "groups"]),
  };
}

/**
 * The provider's answer at the callback: the state taken (once: a replayed callback finds
 * none), bound to this browser (`browserState`, its cookie), the code exchanged with the
 * PKCE verifier, the ID token checked. Returns who signed in and the sign-in's state.
 */
export async function oidcCallback(p: IdentityProvider, params: URLSearchParams, browserState: string | undefined): Promise<{ identity: Identity; state: SsoState; claims: Record<string, unknown> }> {
  const urls = spUrls(p.id);
  if (!urls) throw new SsoError("notConfigured", "PUBLIC_URL is not set");
  const stateParam = params.get("state") ?? "";
  if (!stateParam) throw new SsoError("invalid", "no state");
  const state = await takeState("oidc", stateParam, p.id);
  if (!state) throw new SsoError("expired", "unknown, used or expired state");
  if (!browserState || browserState !== stateParam) throw new SsoError("invalid", "the state is not this browser's");
  const as = await serverOf(p);
  const c = client(p);
  let callback: URLSearchParams;
  try {
    callback = oauth.validateAuthResponse(as, c, params, stateParam);
  } catch (e) {
    throw new SsoError(e instanceof oauth.AuthorizationResponseError ? "refused" : "invalid", String(e));
  }
  let claims: Record<string, unknown>;
  let idToken: string;
  try {
    const res = await oauth.authorizationCodeGrantRequest(as, c, clientAuth(p, as), callback, urls.redirectUri, state.pkceVerifier, fetchOptions(as.token_endpoint ?? ""));
    const tokens = await oauth.processAuthorizationCodeResponse(as, c, res, { expectedNonce: state.nonce, requireIdToken: true });
    claims = { ...(oauth.getValidatedIdTokenClaims(tokens) ?? {}) };
    idToken = tokens.id_token ?? "";
  } catch (e) {
    if (e instanceof SsoError) throw e;
    throw new SsoError(e instanceof oauth.ResponseBodyError ? "refused" : "invalid", String(e));
  }
  await verifyIdTokenSignature(as, idToken, p.clientId);
  // Entra ID: the tenant the token was issued in must be the one set.
  if (p.tenantId && text(claims.tid) !== p.tenantId) throw new SsoError("invalid", "the token is from another tenant");
  const identity = identityFromClaims(p, claims);
  if (!identity.subject) throw new SsoError("invalid", "no subject");
  return { identity, state, claims };
}
