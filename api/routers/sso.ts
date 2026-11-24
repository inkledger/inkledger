// Settings › Single sign-on: identity providers (OIDC, SAML), their SCIM tokens, enforcement,
// and what the login page offers. Owner-only (manageAuth): a provider decides who gets in.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { identityProviders, scimTokens, type IdentityProvider } from "@db/schema";
import { t } from "@contracts/i18n";
import { claimMapSchema, groupMapSchema, SCIM_BASE, SCIM_TOKEN_PREFIX, SSO_KINDS, ssoAccessSchema } from "@contracts/sso";
import { createRouter, permProcedure, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { breakGlassOwners } from "../queries/accounts";
import { sha256Hex } from "../lib/hash";
import { env } from "../lib/env";
import { activeProviders, claimMapOf, defaultAccessOf, groupMapOf, providerById, sealClientSecret } from "../sso/store";
import { assertIdpUrl, forgetProvider, SsoError } from "../sso/oidc";
import { spUrls } from "../sso/urls";
import { linkedCount } from "../sso/accounts";
import { ssoTests } from "../sso/routes";

const manage = permProcedure("manageAuth");

const notFound = () => new TRPCError({ code: "NOT_FOUND", message: t("server.sso.providerNotFound") });

const url = z.string().trim().url().max(2048);
const optionalUrl = z.union([url, z.literal("")]).optional();

/** A provider as Settings edits it. The client secret: undefined keeps the one saved, "" removes it. */
export const providerInput = z.object({
  kind: z.enum(SSO_KINDS),
  name: z.string().trim().min(1).max(80),
  issuer: z.string().trim().max(2048).default(""),
  clientId: z.string().trim().max(512).default(""),
  clientSecret: z.string().max(4096).optional(),
  discoveryUrl: optionalUrl,
  tenantId: z.string().trim().max(128).optional(),
  samlEntryPoint: optionalUrl,
  samlIdpCert: z.string().max(64 * 1024).optional(),
  scopes: z.string().trim().max(512).default("openid email profile"),
  claimMap: claimMapSchema.default({}),
  groupMap: groupMapSchema.default([]),
  jitEnabled: z.boolean().default(false),
  defaultAccess: ssoAccessSchema.default({ permissions: [], teamIds: [] }),
  disabled: z.boolean().default(false),
});
type ProviderInput = z.infer<typeof providerInput>;

/** What a provider needs to work, checked before it is saved (addresses the server will call). */
async function assertUsable(p: ProviderInput) {
  try {
    if (p.kind === "oidc") {
      if (!p.issuer || !p.clientId) throw new SsoError("notConfigured", "OpenID Connect needs the issuer and the client id");
      await assertIdpUrl(p.discoveryUrl || p.issuer);
    } else {
      if (!p.samlEntryPoint || !p.samlIdpCert?.trim()) throw new SsoError("notConfigured", "SAML needs the IdP's sign-in URL and certificate");
      await assertIdpUrl(p.samlEntryPoint);
    }
  } catch (e) {
    if (e instanceof SsoError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
    throw new TRPCError({ code: "BAD_REQUEST", message: String(e instanceof Error ? e.message : e) });
  }
}

const values = (p: ProviderInput) => ({
  kind: p.kind,
  name: p.name,
  issuer: p.issuer,
  clientId: p.clientId,
  discoveryUrl: p.discoveryUrl || null,
  tenantId: p.tenantId?.trim() || null,
  samlEntryPoint: p.samlEntryPoint || null,
  samlIdpCert: p.samlIdpCert?.trim() || null,
  scopes: p.scopes || "openid email profile",
  claimMap: JSON.stringify(p.claimMap),
  groupMap: JSON.stringify(p.groupMap),
  jitEnabled: p.jitEnabled ? 1 : 0,
  defaultAccess: JSON.stringify(p.defaultAccess),
});

/** What the audit keeps of a provider (never its secret). */
const view = (p: IdentityProvider) => ({ kind: p.kind, name: p.name, issuer: p.issuer, jitEnabled: p.jitEnabled === 1, enforced: p.enforced === 1, disabled: Boolean(p.disabledAt) });
const providerTarget = (p: { id: number }) => ({ type: "identityProvider", id: p.id });

async function providerRow(p: IdentityProvider) {
  const tokens = await getDb()
    .select({ id: scimTokens.id, label: scimTokens.label, createdAt: scimTokens.createdAt, lastUsedAt: scimTokens.lastUsedAt })
    .from(scimTokens)
    .where(and(eq(scimTokens.providerId, p.id), isNull(scimTokens.revokedAt)))
    .orderBy(asc(scimTokens.id));
  return {
    id: p.id,
    kind: p.kind === "saml" ? ("saml" as const) : ("oidc" as const),
    name: p.name,
    issuer: p.issuer,
    clientId: p.clientId,
    hasSecret: Boolean(p.clientSecretSealed),
    discoveryUrl: p.discoveryUrl ?? "",
    tenantId: p.tenantId ?? "",
    samlEntryPoint: p.samlEntryPoint ?? "",
    samlIdpCert: p.samlIdpCert ?? "",
    scopes: p.scopes,
    claimMap: claimMapOf(p),
    groupMap: groupMapOf(p),
    jitEnabled: p.jitEnabled === 1,
    defaultAccess: defaultAccessOf(p),
    enforced: p.enforced === 1,
    disabled: Boolean(p.disabledAt),
    urls: spUrls(p.id),
    linked: await linkedCount(p.id),
    scimTokens: tokens.map((tk) => ({ id: tk.id, label: tk.label, createdAt: tk.createdAt.getTime(), lastUsedAt: tk.lastUsedAt?.getTime() ?? null })),
  };
}

async function existing(id: number): Promise<IdentityProvider> {
  const p = await providerById(id);
  if (!p) throw notFound();
  return p;
}

export const ssoRouter = createRouter({
  /** What the login page offers: a button per provider that is on, and whether password sign-in is for break-glass only. */
  loginOptions: publicQuery.query(async () => {
    const all = await activeProviders();
    return { providers: all.map((p) => ({ id: p.id, name: p.name, kind: p.kind })), enforced: all.some((p) => p.enforced === 1) };
  }),

  /** Every provider, with this server's addresses for it and its SCIM tokens (never a secret). */
  list: manage.query(async () => {
    const all = await getDb().select().from(identityProviders).orderBy(asc(identityProviders.id));
    return {
      providers: await Promise.all(all.map(providerRow)),
      publicUrl: env.publicUrl,
      scimBase: env.publicUrl ? `${env.publicUrl.replace(/\/+$/, "")}${SCIM_BASE}` : null,
      breakGlassOwners: (await breakGlassOwners()).length,
    };
  }),

  /** What the admin's last test sign-in found (the identity, the access it would get). */
  testResult: manage.query(({ ctx }) => ssoTests.get(ctx.user.id) ?? null),

  createProvider: manage.input(providerInput).mutation(async ({ input, ctx }) => {
    await assertUsable(input);
    const made = await getDb().transaction(async (tx) => {
      const [row] = await tx.insert(identityProviders).values({ ...values(input), disabledAt: input.disabled ? new Date() : null }).returning();
      if (!input.clientSecret) return row;
      const [sealed] = await tx.update(identityProviders).set({ clientSecretSealed: sealClientSecret(row.id, input.clientSecret) }).where(eq(identityProviders.id, row.id)).returning();
      return sealed;
    });
    ctx.audit.set({ target: providerTarget(made), after: view(made) });
    return providerRow(made);
  }),

  updateProvider: manage.input(providerInput.extend({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const before = await existing(input.id);
    await assertUsable(input);
    const secret = input.clientSecret === undefined ? {} : { clientSecretSealed: input.clientSecret ? sealClientSecret(before.id, input.clientSecret) : null };
    // Turned off, it can't stay enforced (nobody could sign in through it).
    const off = input.disabled ? { disabledAt: before.disabledAt ?? new Date(), enforced: 0 } : { disabledAt: null };
    const [after] = await getDb().update(identityProviders).set({ ...values(input), ...secret, ...off }).where(eq(identityProviders.id, before.id)).returning();
    forgetProvider(before.id);
    ctx.audit.set({ target: providerTarget(after), before: view(before), after: { ...view(after), secretChanged: input.clientSecret !== undefined } });
    return providerRow(after);
  }),

  /** Gone with its links and SCIM tokens; the accounts it brought stay (an admin turns them off or gives them a password). */
  removeProvider: manage.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const before = await existing(input.id);
    await getDb().delete(identityProviders).where(eq(identityProviders.id, before.id));
    forgetProvider(before.id);
    ctx.audit.set({ target: providerTarget(before), before: { kind: before.kind, name: before.name } });
    return { ok: true };
  }),

  /**
   * Everyone signs in through single sign-on except break-glass accounts. Refused while no
   * owner keeps password sign-in (break-glass, local, a password set): a provider that fails
   * would lock everyone out.
   */
  setEnforced: manage.input(z.object({ id: z.number().int().positive(), enforced: z.boolean() })).mutation(async ({ input, ctx }) => {
    const before = await existing(input.id);
    if (input.enforced && before.disabledAt) throw notFound();
    if (input.enforced && (await breakGlassOwners()).length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.sso.noBreakGlass") });
    const [after] = await getDb().update(identityProviders).set({ enforced: input.enforced ? 1 : 0 }).where(eq(identityProviders.id, before.id)).returning();
    ctx.audit.set({ target: providerTarget(after), before: { name: before.name, enforced: before.enforced === 1 }, after: { name: after.name, enforced: after.enforced === 1 } });
    return providerRow(after);
  }),

  /** A SCIM bearer token, shown this once (only its hash is kept). */
  createScimToken: manage.input(z.object({ providerId: z.number().int().positive(), label: z.string().trim().max(80).default("") })).mutation(async ({ input, ctx }) => {
    const p = await existing(input.providerId);
    const token = `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const [row] = await getDb().insert(scimTokens).values({ providerId: p.id, tokenHash: sha256Hex(token), label: input.label, createdBy: ctx.user.id }).returning();
    ctx.audit.set({ target: { type: "scimToken", id: row.id }, after: { provider: p.name, label: row.label } });
    return { id: row.id, token };
  }),

  revokeScimToken: manage.input(z.object({ id: z.number().int().positive() })).mutation(async ({ input, ctx }) => {
    const [row] = await getDb()
      .update(scimTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(scimTokens.id, input.id), isNull(scimTokens.revokedAt)))
      .returning();
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: t("server.sso.tokenNotFound") });
    const p = await providerById(row.providerId);
    ctx.audit.set({ target: { type: "scimToken", id: row.id }, before: { provider: p?.name ?? "", label: row.label } });
    return { ok: true };
  }),
});
