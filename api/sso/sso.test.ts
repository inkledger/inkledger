import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

/**
 * Single sign-on against the simulated identity providers (api/sso/simulators): the OIDC code
 * flow (ID token checks, PKCE, state replay, browser binding), SAML (signed assertions only,
 * audience, Destination, InResponseTo taken once, signature wrapping), and the accounts a
 * sign-in brings (group map clamping, JIT once under concurrent callbacks, linking by subject).
 */

process.env.DATABASE_URL = ":memory:";
process.env.PUBLIC_URL = "http://localhost:3000";
process.env.SSO_ALLOW_LOCAL_IDP = "1";

type Sim = import("./simulators/oidc").OidcSimulator;
type Provider = import("@db/schema").IdentityProvider;

const who = { req: new Request("http://localhost:3000/api/sso/1/callback"), remoteAddress: "192.0.2.1" };

async function insertProvider(values: Partial<typeof import("@db/schema").identityProviders.$inferInsert> & { kind: "oidc" | "saml" }): Promise<Provider> {
  const { getDb } = await import("../queries/connection");
  const { identityProviders } = await import("@db/schema");
  const [p] = await getDb().insert(identityProviders).values({ name: "Test IdP", ...values }).returning();
  return p;
}

beforeAll(async () => {
  const { resetDbForTests } = await import("../queries/connection");
  await resetDbForTests();
});

describe("resolveAccess: what a provider's groups hand out", () => {
  const OWNER = 1;
  it("an unmapped person gets the default access, clamped: never the owner role nor an owner-only power", async () => {
    const { resolveAccess } = await import("./accounts");
    const out = resolveAccess([{ group: "admins", roleId: OWNER, permissions: [], teamIds: [] }], { roleId: OWNER, permissions: ["manageUsers", "manageAuth", "viewTeamTime"], teamIds: [3, 3] }, ["staff"], OWNER);
    expect(out).toEqual({ owner: false, roleId: null, permissions: ["viewTeamTime"], teamIds: [3] });
  });

  it("only a group explicitly mapped to the owner role makes an owner; matching is case-blind and entries add up", async () => {
    const { resolveAccess } = await import("./accounts");
    const map = [
      { group: "Admins", roleId: OWNER, permissions: [], teamIds: [] },
      { group: "leads", roleId: 7, permissions: ["viewAudit" as const], teamIds: [2] },
    ];
    expect(resolveAccess(map, { permissions: [], teamIds: [] }, ["admins"], OWNER)).toMatchObject({ owner: true, roleId: OWNER });
    expect(resolveAccess(map, { permissions: [], teamIds: [] }, ["LEADS", "other"], OWNER)).toEqual({ owner: false, roleId: 7, permissions: ["viewAudit"], teamIds: [2] });
  });

  it("usernames are made from what the provider sends, always valid", async () => {
    const { usernameFrom } = await import("./accounts");
    expect(usernameFrom({ username: "Ada.Lovelace@Example.com", email: "", subject: "x" })).toBe("ada.lovelace");
    expect(usernameFrom({ username: "", email: "", subject: "Ω" })).toMatch(/^[a-z0-9][a-z0-9._-]{1,31}$/);
  });

  it("the place to go back to is a path of this app only", async () => {
    const { safeRelay } = await import("./urls");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "/login?x", "/api/sso/1/start", "javascript:alert(1)"]) expect(safeRelay(bad)).toBe("/");
    expect(safeRelay("/issues?q=open")).toBe("/issues?q=open");
  });
});

describe("OIDC: authorization code with PKCE, state and nonce", () => {
  let sim: Sim;
  let p: Provider;

  beforeAll(async () => {
    const { oidcSimulator } = await import("./simulators/oidc");
    sim = await oidcSimulator({ issuer: "http://127.0.0.1:47991" });
    vi.stubGlobal("fetch", sim.fetch);
    const { sealClientSecret } = await import("./store");
    p = await insertProvider({ kind: "oidc", issuer: sim.issuer, clientId: sim.clientId, jitEnabled: 1 });
    const { getDb } = await import("../queries/connection");
    const { identityProviders } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    [p] = await getDb().update(identityProviders).set({ clientSecretSealed: sealClientSecret(p.id, sim.clientSecret) }).where(eq(identityProviders.id, p.id)).returning();
  });

  beforeEach(() => {
    sim.state.tamper = null;
    sim.state.deny = false;
  });

  const start = async () => (await import("./oidc")).oidcStart(p, { relay: "/", mode: "login" });

  it("signs in: the start asks for S256 PKCE, a state and a nonce; the callback checks the token and says who", async () => {
    const { oidcCallback } = await import("./oidc");
    const { url, state } = await start();
    const asked = new URL(url).searchParams;
    expect(asked.get("code_challenge_method")).toBe("S256");
    expect(asked.get("redirect_uri")).toBe(`http://localhost:3000/api/sso/${p.id}/callback`);
    expect(asked.get("nonce")).toBeTruthy();
    const back = await sim.signIn(url);
    const out = await oidcCallback(p, back, state);
    expect(out.identity).toMatchObject({ subject: "sim-user-1", email: "ada@example.com", groups: ["staff"] });
    expect(sim.state.tokenRequests.at(-1)).toMatchObject({ auth: "basic" });
    expect(sim.state.tokenRequests.at(-1)?.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it.each([
    ["aud", "invalid"],
    ["iss", "invalid"],
    ["nonce", "invalid"],
    ["expired", "invalid"],
    ["otherKey", "invalid"],
    ["none", "invalid"],
  ] as const)("refuses an ID token with a bad %s", async (tamper, failure) => {
    const { oidcCallback } = await import("./oidc");
    const { url, state } = await start();
    sim.state.tamper = tamper;
    const back = await sim.signIn(url);
    await expect(oidcCallback(p, back, state)).rejects.toMatchObject({ name: "SsoError", failure });
  });

  it("a callback is taken once: the same state again finds nothing (replay)", async () => {
    const { oidcCallback } = await import("./oidc");
    const { url, state } = await start();
    const back = await sim.signIn(url);
    await oidcCallback(p, back, state);
    await expect(oidcCallback(p, back, state)).rejects.toMatchObject({ failure: "expired" });
  });

  it("a callback in another browser (no cookie with its state) is refused, and its state is spent", async () => {
    const { oidcCallback } = await import("./oidc");
    const { url, state } = await start();
    const back = await sim.signIn(url);
    await expect(oidcCallback(p, back, undefined)).rejects.toMatchObject({ failure: "invalid" });
    await expect(oidcCallback(p, back, state)).rejects.toMatchObject({ failure: "expired" });
  });

  it("PKCE: a code exchanged without the verifier it was issued for is refused by the provider", async () => {
    const { oidcCallback } = await import("./oidc");
    const { url, state } = await start();
    const back = await sim.signIn(url);
    // The state row (with its verifier) of another sign-in: the code's challenge doesn't match.
    const other = await start();
    const { getDb } = await import("../queries/connection");
    const { ssoStates } = await import("@db/schema");
    const rows = await getDb().select().from(ssoStates);
    const { sha256Hex } = await import("../lib/hash");
    const mine = rows.find((r) => r.id === sha256Hex(`oidc:${state}`));
    const theirs = rows.find((r) => r.id === sha256Hex(`oidc:${other.state}`));
    const { eq } = await import("drizzle-orm");
    await getDb().update(ssoStates).set({ pkceVerifier: theirs?.pkceVerifier ?? "x" }).where(eq(ssoStates.id, mine?.id ?? ""));
    await expect(oidcCallback(p, back, state)).rejects.toMatchObject({ failure: "refused" });
  });

  it("a person who says no at the provider is told so", async () => {
    const { oidcCallback } = await import("./oidc");
    const { url, state } = await start();
    sim.state.deny = true;
    const back = await sim.signIn(url);
    await expect(oidcCallback(p, back, state)).rejects.toMatchObject({ failure: "refused" });
  });

  it("a rotated signing key is fetched again once", async () => {
    const { oidcCallback } = await import("./oidc");
    const first = await start();
    await oidcCallback(p, await sim.signIn(first.url), first.state);
    await sim.rotate();
    const { url, state } = await start();
    await expect(oidcCallback(p, await sim.signIn(url), state)).resolves.toMatchObject({ identity: { subject: "sim-user-1" } });
  });

  it("Entra ID: a token from another tenant is refused", async () => {
    const { oidcSimulator } = await import("./simulators/oidc");
    const entra = await oidcSimulator({ issuer: "http://127.0.0.1:47992/tenant-a/v2.0", tenantId: "tenant-a" });
    vi.stubGlobal("fetch", entra.fetch);
    try {
      const tp = await insertProvider({ kind: "oidc", issuer: entra.issuer, clientId: entra.clientId, tenantId: "tenant-a" });
      const { sealClientSecret } = await import("./store");
      const { getDb } = await import("../queries/connection");
      const { identityProviders } = await import("@db/schema");
      const { eq } = await import("drizzle-orm");
      const [withSecret] = await getDb().update(identityProviders).set({ clientSecretSealed: sealClientSecret(tp.id, entra.clientSecret) }).where(eq(identityProviders.id, tp.id)).returning();
      const { oidcStart, oidcCallback } = await import("./oidc");
      const ok = await oidcStart(withSecret, { relay: "/", mode: "login" });
      await expect(oidcCallback(withSecret, await entra.signIn(ok.url), ok.state)).resolves.toBeTruthy();
      entra.state.tamper = "tid";
      const bad = await oidcStart(withSecret, { relay: "/", mode: "login" });
      await expect(oidcCallback(withSecret, await entra.signIn(bad.url), bad.state)).rejects.toMatchObject({ failure: "invalid" });
    } finally {
      vi.stubGlobal("fetch", sim.fetch);
    }
  });

  it("JIT: two callbacks of the same new person at once make one account, linked by subject", async () => {
    const { accountFor } = await import("./accounts");
    const identity = { subject: "jit-1", username: "grace@example.com", email: "grace@example.com", name: "Grace Hopper", groups: [] };
    const [a, b] = await Promise.all([accountFor(p, identity, who), accountFor(p, identity, who)]);
    expect("user" in a && "user" in b && a.user.id === b.user.id).toBe(true);
    const { q } = await import("../queries/connection");
    expect(await q("SELECT count(*)::int AS n FROM users WHERE username LIKE 'grace%'")).toEqual([{ n: 1 }]);
    expect(await q("SELECT auth_source, password_hash FROM users WHERE username = 'grace'")).toEqual([{ auth_source: "sso", password_hash: null }]);
  });

  it("never links by address: a local account with the same email stays apart", async () => {
    const { q } = await import("../queries/connection");
    await q("INSERT INTO users (username, display_name, email, created_at) VALUES ('linus', 'Linus', 'linus@example.com', 1)");
    const { accountFor } = await import("./accounts");
    const out = await accountFor(p, { subject: "jit-2", username: "linus@example.com", email: "linus@example.com", name: "Not Linus", groups: [] }, who);
    expect("user" in out && out.user.username).toBe("linus-2");
  });

  it("without JIT, an unknown person is not let in", async () => {
    const { accountFor } = await import("./accounts");
    const closed = await insertProvider({ kind: "oidc", issuer: "http://127.0.0.1:47993", clientId: "c", jitEnabled: 0 });
    expect(await accountFor(closed, { subject: "nobody", username: "nobody", email: "", name: "", groups: [] }, who)).toEqual({ failure: "notProvisioned" });
  });
});

describe("SAML: SP-initiated, signed assertions only", () => {
  type SamlSim = import("./simulators/saml").SamlSimulator;
  let sim: SamlSim;
  let p: Provider;

  beforeAll(async () => {
    const { samlSimulator } = await import("./simulators/saml");
    sim = samlSimulator();
    p = await insertProvider({ kind: "saml", issuer: sim.entityId, samlEntryPoint: sim.entryPoint, samlIdpCert: sim.certPem, jitEnabled: 1 });
  });

  const start = async () => (await (await import("./saml")).samlStart(p, { relay: "/", mode: "login" })).url;
  const acs = async (r: { SAMLResponse: string }) => (await import("./saml")).samlAcs(p, r);

  it("signs in with a signed assertion that answers this server's request", async () => {
    const url = await start();
    const out = await acs(sim.respond(url));
    expect(out.identity).toMatchObject({ subject: "ada@example.com", email: "ada@example.com", name: "Ada Lovelace", groups: ["staff"] });
  });

  it("the SP metadata names this server's ACS and entity id", async () => {
    const { samlMetadata } = await import("./saml");
    const xml = samlMetadata(p);
    expect(xml).toContain(`http://localhost:3000/api/sso/${p.id}/acs`);
    expect(xml).toContain(`entityID="http://localhost:3000/api/sso/${p.id}/metadata"`);
  });

  it.each([
    ["an unsigned assertion", { signed: false }],
    ["another audience", { audience: "https://someone-else.example/metadata" }],
    ["another Destination", { destination: "https://evil.example/acs" }],
    ["another Recipient", { recipient: "https://evil.example/acs" }],
    ["a certificate it wasn't given", { untrustedKey: true }],
    ["an expired assertion", { expiredMinutes: 30 }],
  ] as const)("refuses %s", async (_name, answer) => {
    const url = await start();
    await expect(acs(sim.respond(url, answer))).rejects.toMatchObject({ name: "SsoError" });
  });

  it("refuses an answer to a request it never made (unsolicited, IdP-initiated)", async () => {
    const url = await start();
    await expect(acs(sim.respond(url, { inResponseTo: "_never-asked" }))).rejects.toMatchObject({ name: "SsoError" });
  });

  it("an InResponseTo is taken once: the same response posted again is refused (replay)", async () => {
    const url = await start();
    const r = sim.respond(url);
    await acs(r);
    await expect(acs(r)).rejects.toMatchObject({ name: "SsoError" });
  });

  it.each(["sibling", "wrapped"] as const)("signature wrapping (%s): a forged assertion beside the signed one never signs anyone in", async (shape) => {
    const url = await start();
    const r = sim.respond(url, { wrap: { shape, as: { nameId: "root@example.com", attributes: { email: "root@example.com", groups: ["admins"] } } } });
    const out = await acs(r).then((o) => o.identity.subject, (e: unknown) => (e as Error).name);
    expect(out).not.toBe("root@example.com");
  });
});
