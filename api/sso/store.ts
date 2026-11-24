// Identity providers as stored, and the short-lived state of a sign-in under way at one.
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { identityProviders, ssoStates, type IdentityProvider } from "@db/schema";
import { claimMapSchema, groupMapSchema, ssoAccessSchema, SSO_STATE_MINUTES, type ClaimMap, type GroupMapEntry, type SsoAccess } from "@contracts/sso";
import { getDb, type Db } from "../queries/connection";
import { openFor, sealFor } from "../lib/crypto";
import { sha256Hex } from "../lib/hash";

type Reader = Pick<Db, "select">;

const parsed = <T>(raw: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, fallback: T): T => {
  try {
    const out = schema.safeParse(JSON.parse(raw));
    return out.success ? out.data : fallback;
  } catch {
    return fallback;
  }
};

export const claimMapOf = (p: Pick<IdentityProvider, "claimMap">): ClaimMap => parsed(p.claimMap, claimMapSchema, {});
export const groupMapOf = (p: Pick<IdentityProvider, "groupMap">): GroupMapEntry[] => parsed(p.groupMap, groupMapSchema, []);
export const defaultAccessOf = (p: Pick<IdentityProvider, "defaultAccess">): SsoAccess => parsed(p.defaultAccess, ssoAccessSchema, { permissions: [], teamIds: [] });

/** The scope a provider's client secret is sealed for. */
const secretScope = (id: number) => `idp:${id}`;
export const sealClientSecret = (id: number, plain: string) => sealFor(plain, secretScope(id));

/** The provider's client secret in clear ("" when none is kept, or none opens). */
export function clientSecretOf(p: Pick<IdentityProvider, "id" | "clientSecretSealed">): string {
  if (!p.clientSecretSealed) return "";
  try {
    return openFor(p.clientSecretSealed, secretScope(p.id));
  } catch {
    return "";
  }
}

export async function providerById(id: number, db: Reader = getDb()): Promise<IdentityProvider | undefined> {
  const [row] = await db.select().from(identityProviders).where(eq(identityProviders.id, id)).limit(1);
  return row;
}

/** A provider people may sign in through now (not turned off). */
export async function activeProvider(id: number): Promise<IdentityProvider | undefined> {
  const [row] = await getDb()
    .select()
    .from(identityProviders)
    .where(and(eq(identityProviders.id, id), isNull(identityProviders.disabledAt)))
    .limit(1);
  return row;
}

export async function activeProviders(): Promise<IdentityProvider[]> {
  return getDb().select().from(identityProviders).where(isNull(identityProviders.disabledAt)).orderBy(identityProviders.id);
}

/** Single sign-on is enforced: a provider that is on says so (password sign-in only for break-glass accounts). */
export async function ssoEnforced(db: Reader = getDb()): Promise<boolean> {
  const [row] = await db
    .select({ id: identityProviders.id })
    .from(identityProviders)
    .where(and(eq(identityProviders.enforced, 1), isNull(identityProviders.disabledAt)))
    .limit(1);
  return Boolean(row);
}

// ---------------------------------------------------------------------------
// Sign-ins under way: keyed by the hash of the OIDC state or the SAML request id, taken once.

export type SsoState = typeof ssoStates.$inferSelect;
export type StateInput = { relay: string; mode: "login" | "test"; userId?: number | null; nonce?: string; pkceVerifier?: string };

const stateKey = (kind: "oidc" | "saml" | "replay", value: string) => sha256Hex(`${kind}:${value}`);

export async function saveState(kind: "oidc" | "saml", value: string, providerId: number, s: StateInput): Promise<void> {
  await getDb()
    .insert(ssoStates)
    .values({
      id: stateKey(kind, value),
      providerId,
      relay: s.relay,
      mode: s.mode,
      userId: s.userId ?? null,
      nonce: s.nonce ?? "",
      pkceVerifier: s.pkceVerifier ?? "",
      expiresAt: new Date(Date.now() + SSO_STATE_MINUTES * 60_000),
    });
}

/** The state of a sign-in, taken in one step (a second callback with it finds nothing): null when unknown, used or expired. */
export async function takeState(kind: "oidc" | "saml", value: string, providerId: number): Promise<SsoState | null> {
  const [row] = await getDb()
    .delete(ssoStates)
    .where(and(eq(ssoStates.id, stateKey(kind, value)), eq(ssoStates.providerId, providerId), gt(ssoStates.expiresAt, new Date()), sql`${ssoStates.mode} <> 'replay'`))
    .returning();
  return row ?? null;
}

/** The state of a sign-in, read without taking it (SAML reads its request before the checks, takes it after). */
export async function peekState(kind: "oidc" | "saml", value: string, providerId: number): Promise<SsoState | null> {
  const [row] = await getDb()
    .select()
    .from(ssoStates)
    .where(and(eq(ssoStates.id, stateKey(kind, value)), eq(ssoStates.providerId, providerId), gt(ssoStates.expiresAt, new Date()), sql`${ssoStates.mode} <> 'replay'`))
    .limit(1);
  return row ?? null;
}

/** A state dropped (a sign-in the provider refused). */
export async function dropState(kind: "oidc" | "saml", value: string, providerId: number): Promise<void> {
  await getDb().delete(ssoStates).where(and(eq(ssoStates.id, stateKey(kind, value)), eq(ssoStates.providerId, providerId)));
}

/**
 * An assertion seen once (SAML replay): true when it was not seen before (now kept until
 * `untilMs`), false when it was. One statement: two copies at once can't both be first.
 */
export async function firstSighting(providerId: number, key: string, untilMs: number): Promise<boolean> {
  const id = stateKey("replay", key);
  await getDb().delete(ssoStates).where(and(eq(ssoStates.id, id), lte(ssoStates.expiresAt, new Date())));
  const saved = await getDb()
    .insert(ssoStates)
    .values({ id, providerId, mode: "replay", relay: "", expiresAt: new Date(untilMs) })
    .onConflictDoNothing()
    .returning({ id: ssoStates.id });
  return saved.length === 1;
}

/** States past their minutes (with the sessions' purge). */
export async function purgeSsoStates(now = Date.now()): Promise<number> {
  const gone = await getDb().delete(ssoStates).where(lte(ssoStates.expiresAt, new Date(now))).returning({ id: ssoStates.id });
  return gone.length;
}
