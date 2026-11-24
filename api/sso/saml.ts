// SAML 2.0 sign-in, SP-initiated only: the request's id is kept on the server (sso_states)
// and the response must answer it (InResponseTo, taken once), because the SameSite=Lax
// cookie never comes with the provider's cross-site POST. Signed assertions are required;
// audience, Destination, Recipient, clock skew and replays are checked (@node-saml/node-saml,
// and Destination/Recipient here, which that library only warns about).
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from "@node-saml/node-saml";
import { DOMParser } from "@xmldom/xmldom";
import type { IdentityProvider } from "@db/schema";
import { SSO_STATE_MINUTES } from "@contracts/sso";
import { claimMapOf, dropState, firstSighting, peekState, saveState, takeState, type SsoState, type StateInput } from "./store";
import { spUrls, type SpUrls } from "./urls";
import { SsoError } from "./oidc";
import type { Identity } from "./accounts";

/** Clock difference with the provider tolerated on the assertion's times. */
export const SAML_CLOCK_SKEW_MS = 2 * 60_000;

/** Where a state row lands once taken (one per request). */
type Taken = { row: SsoState | null };

/** The request ids of this provider, in sso_states: saved at the start, read, then taken once. */
function cacheFor(providerId: number, start: StateInput | null, taken: Taken): CacheProvider {
  return {
    async saveAsync(key, value) {
      if (!start) return null;
      await saveState("saml", key, providerId, start);
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      const row = await peekState("saml", key, providerId);
      return row ? row.createdAt.toISOString() : null;
    },
    async consumeAsync(key) {
      const row = await takeState("saml", key, providerId);
      if (row) taken.row = row;
      return row ? row.createdAt.toISOString() : null;
    },
    async removeAsync(key) {
      if (key) await dropState("saml", key, providerId);
      return null;
    },
    async saveIfAbsentAsync(key, _value, expiresAtMs) {
      return firstSighting(providerId, key, expiresAtMs);
    },
  };
}

function certs(pem: string): string[] {
  const found = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (found?.length) return found;
  const bare = pem.replace(/\s+/g, "");
  return bare ? [bare] : [];
}

function samlFor(p: IdentityProvider, urls: SpUrls, cache: CacheProvider): SAML {
  const idpCert = certs(p.samlIdpCert ?? "");
  if (!p.samlEntryPoint || idpCert.length === 0) throw new SsoError("notConfigured", "SAML needs the IdP's sign-in URL and certificate");
  return new SAML({
    entryPoint: p.samlEntryPoint,
    issuer: urls.entityId,
    callbackUrl: urls.acs,
    audience: urls.entityId,
    idpCert,
    ...(p.issuer ? { idpIssuer: p.issuer } : {}),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    rejectReplayedAssertions: true,
    requestIdExpirationPeriodMs: SSO_STATE_MINUTES * 60_000,
    acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
    cacheProvider: cache,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
    disableRequestedAuthnContext: true,
  });
}

const needUrls = (p: IdentityProvider): SpUrls => {
  const urls = spUrls(p.id);
  if (!urls) throw new SsoError("notConfigured", "PUBLIC_URL is not set");
  return urls;
};

/** Where the browser goes to sign in (the request's id kept for the answer). */
export async function samlStart(p: IdentityProvider, s: Omit<StateInput, "nonce" | "pkceVerifier">): Promise<{ url: string }> {
  const urls = needUrls(p);
  const saml = samlFor(p, urls, cacheFor(p.id, s, { row: null }));
  return { url: await saml.getAuthorizeUrlAsync("", undefined, {}) };
}

/** This server as a service provider, for the IdP's set-up (XML). */
export function samlMetadata(p: IdentityProvider): string {
  const urls = needUrls(p);
  return samlFor(p, urls, cacheFor(p.id, null, { row: null })).generateServiceProviderMetadata(null, null);
}

const NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";

/** The Response's Destination, and the Recipients of the (verified) assertion's bearer confirmations. */
function addressees(responseXml: string, assertionXml: string): { destination: string | null; recipients: string[] } {
  const parser = new DOMParser({ onError: () => undefined });
  const response = parser.parseFromString(responseXml, "text/xml").documentElement;
  const destination = response && response.localName === "Response" && response.namespaceURI === NS ? response.getAttribute("Destination") : null;
  const assertion = parser.parseFromString(assertionXml, "text/xml");
  const recipients = [...assertion.getElementsByTagNameNS(ASSERTION_NS, "SubjectConfirmationData")].map((e) => e.getAttribute("Recipient") ?? "");
  return { destination, recipients };
}

const text = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter(Boolean) : typeof v === "string" && v ? [v] : []);

const EMAIL_CLAIMS = ["email", "mail", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "urn:oid:0.9.2342.19200300.100.1.3"];
const NAME_CLAIMS = ["displayName", "http://schemas.microsoft.com/identity/claims/displayname", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name", "urn:oid:2.16.840.1.113730.3.1.241"];
const GROUP_CLAIMS = ["groups", "http://schemas.microsoft.com/ws/2008/06/identity/claims/groups", "memberOf"];

/** What the assertion says about the person, through the claim map (the NameID is the subject unless it says otherwise). */
export function identityFromProfile(p: Pick<IdentityProvider, "claimMap">, profile: Profile): Identity {
  const m = claimMapOf(p);
  const pick = (name: string | undefined, fallbacks: string[]) => (name ? profile[name] : fallbacks.map((f) => profile[f]).find((v) => v !== undefined));
  const email = text(pick(m.email, EMAIL_CLAIMS));
  return {
    subject: m.subject ? text(profile[m.subject]) : profile.nameID,
    username: text(pick(m.username, [])) || profile.nameID || email,
    email,
    name: text(pick(m.name, NAME_CLAIMS)),
    groups: list(pick(m.groups, GROUP_CLAIMS)),
  };
}

/**
 * The provider's POST to the ACS: validated against its certificate, answering a request of
 * this provider (taken once), for this server (audience, Destination, Recipient), in time.
 */
export async function samlAcs(p: IdentityProvider, body: { SAMLResponse?: string }): Promise<{ identity: Identity; state: SsoState; profile: Profile }> {
  const urls = needUrls(p);
  if (!body.SAMLResponse || body.SAMLResponse.length > 512 * 1024) throw new SsoError("invalid", "no SAMLResponse");
  const taken: Taken = { row: null };
  const saml = samlFor(p, urls, cacheFor(p.id, null, taken));
  let profile: Profile | null;
  try {
    profile = (await saml.validatePostResponseAsync({ SAMLResponse: body.SAMLResponse })).profile;
  } catch (e) {
    const why = String(e);
    throw new SsoError(/InResponseTo|already been received/.test(why) ? "expired" : /Status|Responder|Requester|AuthnFailed/.test(why) ? "refused" : "invalid", why);
  }
  if (!profile || !taken.row) throw new SsoError("invalid", "no assertion answering a request");
  const assertionXml = profile.getAssertionXml?.() ?? "";
  const { destination, recipients } = addressees(Buffer.from(body.SAMLResponse, "base64").toString("utf8"), assertionXml);
  if (destination !== urls.acs) throw new SsoError("invalid", `Destination ${destination ?? "missing"} is not ${urls.acs}`);
  if (!recipients.includes(urls.acs)) throw new SsoError("invalid", "no bearer confirmation for this server's ACS");
  const identity = identityFromProfile(p, profile);
  if (!identity.subject) throw new SsoError("invalid", "no subject");
  return { identity, state: taken.row, profile };
}
