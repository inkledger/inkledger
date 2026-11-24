// An OpenID Connect identity provider in memory, for tests (Entra ID, Okta, Keycloak and
// Google answer the same way where it matters here): discovery, the authorization endpoint
// (it signs in whoever `user` is, without a page), the token endpoint (authorization code with
// PKCE S256, client_secret_basic or _post) and the keys (JWKS). Its traps, as real ones have them:
// - a code is used once and only with the redirect_uri and code_verifier it was issued for;
// - the keys rotate (`rotate()`): a token signed with a new key has a kid the cached set lacks;
// - `tamper` makes the next ID tokens wrong in one way (audience, issuer, nonce, expired, tenant,
//   signed by another key, unsigned "alg: none") as a forged or misrouted token would be;
// - `deny` answers the authorization with an error (access_denied) instead of a code.
import { createHash, randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from "jose";
import { simRequest } from "../../providers/core/simulator";

export type OidcSimUser = { sub: string; email?: string; name?: string; preferred_username?: string; groups?: string[]; [claim: string]: unknown };
export type OidcTamper = "aud" | "iss" | "nonce" | "expired" | "tid" | "otherKey" | "none" | null;

type Key = { kid: string; privateKey: CryptoKey; jwk: JWK };
type Code = { clientId: string; redirectUri: string; challenge: string; nonce: string; user: OidcSimUser; used: boolean };

const b64url = (b: Buffer) => b.toString("base64url");

async function newKey(): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const kid = b64url(randomBytes(8));
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" } };
}

export async function oidcSimulator(opts: { issuer?: string; clientId?: string; clientSecret?: string; tenantId?: string } = {}) {
  const issuer = (opts.issuer ?? "http://127.0.0.1:47999").replace(/\/+$/, "");
  const clientId = opts.clientId ?? "inkledger-test";
  const clientSecret = opts.clientSecret ?? "simulator-secret";
  const keys: Key[] = [await newKey()];
  const stranger = await newKey();
  const codes = new Map<string, Code>();
  const state = {
    user: { sub: "sim-user-1", email: "ada@example.com", name: "Ada Lovelace", preferred_username: "ada@example.com", groups: ["staff"] } as OidcSimUser,
    tamper: null as OidcTamper,
    deny: false,
    /** Token requests seen (how the client authenticated, which verifier it sent). */
    tokenRequests: [] as { auth: "basic" | "post" | "none"; verifier: string }[],
  };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function idToken(c: Code): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const t = state.tamper;
    const claims: Record<string, unknown> = {
      ...c.user,
      nonce: t === "nonce" ? "someone-elses-nonce" : c.nonce,
      ...(opts.tenantId ? { tid: t === "tid" ? "00000000-0000-0000-0000-000000000000" : opts.tenantId } : {}),
    };
    if (t === "none") {
      const enc = (o: unknown) => b64url(Buffer.from(JSON.stringify(o)));
      return `${enc({ alg: "none", typ: "JWT" })}.${enc({ ...claims, iss: issuer, aud: clientId, iat: now, exp: now + 300 })}.`;
    }
    const key = t === "otherKey" ? stranger : keys[keys.length - 1];
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
      .setIssuer(t === "iss" ? `${issuer}/someone-else` : issuer)
      .setAudience(t === "aud" ? "another-client" : clientId)
      .setIssuedAt(t === "expired" ? now - 3600 : now)
      .setExpirationTime(t === "expired" ? now - 1800 : now + 300)
      .sign(key.privateKey);
  }

  async function token(body: URLSearchParams, headers: Headers): Promise<Response> {
    const basic = /^Basic\s+(.+)$/i.exec(headers.get("authorization") ?? "");
    let id = body.get("client_id") ?? "";
    let secret = body.get("client_secret") ?? "";
    let auth: "basic" | "post" | "none" = secret ? "post" : "none";
    if (basic) {
      const [u, p] = Buffer.from(basic[1], "base64").toString("utf8").split(":").map(decodeURIComponent);
      id = u;
      secret = p ?? "";
      auth = "basic";
    }
    state.tokenRequests.push({ auth, verifier: body.get("code_verifier") ?? "" });
    if (id !== clientId || secret !== clientSecret) return json({ error: "invalid_client" }, 401);
    if (body.get("grant_type") !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);
    const c = codes.get(body.get("code") ?? "");
    if (!c || c.used || c.clientId !== id || c.redirectUri !== body.get("redirect_uri")) return json({ error: "invalid_grant" }, 400);
    c.used = true;
    const challenge = b64url(createHash("sha256").update(body.get("code_verifier") ?? "").digest());
    if (challenge !== c.challenge) return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    return json({ access_token: b64url(randomBytes(24)), token_type: "Bearer", expires_in: 300, id_token: await idToken(c) });
  }

  function authorize(url: URL): Response {
    const p = url.searchParams;
    const redirect = p.get("redirect_uri") ?? "";
    if (p.get("client_id") !== clientId || !redirect) return new Response("unknown client", { status: 400 });
    const back = new URL(redirect);
    back.searchParams.set("state", p.get("state") ?? "");
    if (state.deny) {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "The user said no");
    } else {
      if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) return new Response("PKCE required", { status: 400 });
      const code = b64url(randomBytes(24));
      codes.set(code, { clientId, redirectUri: redirect, challenge: p.get("code_challenge") ?? "", nonce: p.get("nonce") ?? "", user: { ...state.user }, used: false });
      back.searchParams.set("code", code);
    }
    back.searchParams.set("iss", issuer);
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  async function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const { url, method, headers } = simRequest(input, init);
    if (`${url.origin}` !== new URL(issuer).origin) return new Response("not this provider", { status: 404 });
    const path = url.pathname.replace(new URL(issuer).pathname.replace(/\/$/, ""), "");
    if (path === "/.well-known/openid-configuration") {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/keys`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (path === "/keys") return json({ keys: keys.map((k) => k.jwk) });
    if (path === "/authorize" && method === "GET") return authorize(url);
    if (path === "/token" && method === "POST") return token(new URLSearchParams(typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : ""), headers);
    return new Response("not found", { status: 404 });
  }

  return {
    issuer,
    clientId,
    clientSecret,
    state,
    fetch,
    /** A new signing key (the old one is no longer published). */
    async rotate() {
      keys.splice(0, keys.length, await newKey());
    },
    /** The browser's trip: the authorization URL in, the callback's query out (what comes back to the server). */
    async signIn(authorizationUrl: string): Promise<URLSearchParams> {
      const res = await fetch(authorizationUrl);
      const location = res.headers.get("location");
      if (res.status !== 302 || !location) throw new Error(`authorize answered ${res.status}`);
      return new URL(location).searchParams;
    },
  };
}

export type OidcSimulator = Awaited<ReturnType<typeof oidcSimulator>>;
