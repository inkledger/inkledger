// A SAML 2.0 identity provider in memory, for tests (Entra ID, Okta, Keycloak, ADFS answer
// alike where it matters): it reads the SP-initiated AuthnRequest from the HTTP-Redirect URL
// and answers with a Response for the ACS (HTTP-POST binding), the assertion signed with its
// own key and self-signed certificate (made here: no key is checked in). Knobs model what a
// forged, misrouted or replayed answer looks like: unsigned, another audience, another
// Destination or Recipient, a certificate the SP doesn't trust, expired, and the classic
// signature-wrapping shapes (a forged assertion beside or around the signed one).
// Test-only: imports xml-crypto (a dev dependency), never reached from the server.
import { createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

// ---------------------------------------------------------------------------
// A self-signed X.509 certificate in DER, by hand (a few ASN.1 shapes are all it takes).

const tlv = (tag: number, body: Buffer): Buffer => {
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const int = (b: Buffer) => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const oid = (dotted: string) => {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const bytes = [a * 40 + b];
  for (const v of rest) {
    const chunk = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
};
const utc = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));
const SHA256_RSA = seq(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]));

export function selfSignedCert(cn: string): { privateKey: KeyObject; keyPem: string; certPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(randomBytes(8)),
    SHA256_RSA,
    name(cn),
    seq(utc(new Date(now - 86_400_000)), utc(new Date(now + 3650 * 86_400_000))),
    name(cn),
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = createSign("sha256").update(tbs).sign(privateKey);
  const der = seq(tbs, SHA256_RSA, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n").replace(/\n$/, "")}\n-----END CERTIFICATE-----\n`;
  return { privateKey, keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), certPem };
}

// ---------------------------------------------------------------------------

const PROTOCOL = "urn:oasis:names:tc:SAML:2.0:protocol";
const ASSERTION = "urn:oasis:names:tc:SAML:2.0:assertion";

export type SamlSimUser = { nameId: string; attributes: Record<string, string | string[]> };
export type SamlAnswer = {
  /** Sign the assertion (default true) */
  signed?: boolean;
  audience?: string;
  destination?: string;
  recipient?: string;
  inResponseTo?: string;
  issuer?: string;
  /** Minutes the assertion has been expired for (0: valid now) */
  expiredMinutes?: number;
  /** Signed by a certificate the SP was not given */
  untrustedKey?: boolean;
  /** Status other than Success (the IdP refused) */
  status?: string;
  /** Signature wrapping: a forged assertion for `as` beside the signed one ("sibling") or the signed one hidden inside it ("wrapped") */
  wrap?: { shape: "sibling" | "wrapped"; as: SamlSimUser };
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const id = () => `_${randomBytes(16).toString("hex")}`;

export function samlSimulator(opts: { entityId?: string; entryPoint?: string } = {}) {
  const entityId = opts.entityId ?? "https://idp.example.test/saml";
  const entryPoint = opts.entryPoint ?? "https://idp.example.test/saml/sso";
  const trusted = selfSignedCert("inkledger SAML simulator");
  const stranger = selfSignedCert("someone else");
  const state = {
    user: { nameId: "ada@example.com", attributes: { email: "ada@example.com", displayName: "Ada Lovelace", groups: ["staff"] } } as SamlSimUser,
  };

  /** What the SP asked for, read from its redirect URL (HTTP-Redirect binding: deflated, base64). */
  function readRequest(authorizeUrl: string): { id: string; acs: string; issuer: string; relayState: string | null } {
    const url = new URL(authorizeUrl);
    const raw = url.searchParams.get("SAMLRequest");
    if (!raw) throw new Error("no SAMLRequest");
    const xml = inflateRawSync(Buffer.from(raw, "base64")).toString("utf8");
    const attr = (n: string) => new RegExp(`${n}="([^"]+)"`).exec(xml)?.[1] ?? "";
    const issuer = /<(?:saml2?:)?Issuer[^>]*>([^<]+)</.exec(xml)?.[1] ?? "";
    return { id: attr("ID"), acs: attr("AssertionConsumerServiceURL"), issuer, relayState: url.searchParams.get("RelayState") };
  }

  function assertionXml(user: SamlSimUser, a: { audience: string; recipient: string; inResponseTo: string; issuer: string; expiredMinutes: number }, assertionId = id()): string {
    const now = Date.now() - a.expiredMinutes * 60_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const attrs = Object.entries(user.attributes)
      .map(([k, v]) => `<saml:Attribute Name="${esc(k)}">${(Array.isArray(v) ? v : [v]).map((x) => `<saml:AttributeValue>${esc(x)}</saml:AttributeValue>`).join("")}</saml:Attribute>`)
      .join("");
    return (
      `<saml:Assertion xmlns:saml="${ASSERTION}" ID="${assertionId}" Version="2.0" IssueInstant="${iso(now)}">` +
      `<saml:Issuer>${esc(a.issuer)}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${esc(user.nameId)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${esc(a.inResponseTo)}" NotOnOrAfter="${iso(now + 5 * 60_000)}" Recipient="${esc(a.recipient)}"/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${iso(now - 60_000)}" NotOnOrAfter="${iso(now + 5 * 60_000)}"><saml:AudienceRestriction><saml:Audience>${esc(a.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${id()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` +
      `</saml:Assertion>`
    );
  }

  function sign(xml: string, key: { keyPem: string; certPem: string }): string {
    const sig = new SignedXml({
      privateKey: key.keyPem,
      publicCert: key.certPem,
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    });
    sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
    return sig.getSignedXml();
  }

  /** The Response (base64, as the browser posts it to the ACS) answering the SP's request. */
  function respond(authorizeUrl: string, o: SamlAnswer = {}): { acs: string; SAMLResponse: string; RelayState: string | null; requestId: string } {
    const req = readRequest(authorizeUrl);
    const a = {
      audience: o.audience ?? req.issuer,
      recipient: o.recipient ?? req.acs,
      inResponseTo: o.inResponseTo ?? req.id,
      issuer: o.issuer ?? entityId,
      expiredMinutes: o.expiredMinutes ?? 0,
    };
    let assertion = assertionXml(state.user, a);
    if (o.signed !== false) assertion = sign(assertion, o.untrustedKey ? stranger : trusted);
    if (o.wrap) {
      const forged = assertionXml(o.wrap.as, a);
      // sibling: the forged one first, the signed one after; wrapped: the signed one inside the forged one's Subject.
      assertion = o.wrap.shape === "sibling" ? forged + assertion : forged.replace("</saml:Subject>", `</saml:Subject><saml:Advice>${assertion}</saml:Advice>`);
    }
    const status = o.status ?? "urn:oasis:names:tc:SAML:2.0:status:Success";
    const response =
      `<samlp:Response xmlns:samlp="${PROTOCOL}" xmlns:saml="${ASSERTION}" ID="${id()}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${esc(o.destination ?? req.acs)}" InResponseTo="${esc(a.inResponseTo)}">` +
      `<saml:Issuer>${esc(a.issuer)}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="${esc(status)}"/></samlp:Status>` +
      (status.endsWith(":Success") ? assertion : "") +
      `</samlp:Response>`;
    return { acs: req.acs, SAMLResponse: Buffer.from(response, "utf8").toString("base64"), RelayState: req.relayState, requestId: req.id };
  }

  return { entityId, entryPoint, certPem: trusted.certPem, strangerCertPem: stranger.certPem, state, readRequest, respond };
}

export type SamlSimulator = ReturnType<typeof samlSimulator>;
