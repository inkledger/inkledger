// Single sign-on's HTTP side: start at a provider, come back (OIDC callback, SAML ACS),
// and this server's SAML metadata. A sign-in ends in a session as a password one does
// (auth.ts signIn); a failure goes back to the login page, which says why.
import type { Context, Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import type { IdentityProvider } from "@db/schema";
import { SSO_FAILURE_PARAM, SSO_STATE_MINUTES, type SsoFailure } from "@contracts/sso";
import { parseCookies, restUser, type TrpcContext } from "../context";
import { readSsoCookie, ssoCookie } from "../lib/session";
import { recordSignIn } from "../lib/audit";
import { signIn } from "../routers/auth";
import { accessFor, accountFor, type Identity, type Resolved } from "./accounts";
import { oidcCallback, oidcStart, SsoError } from "./oidc";
import { samlAcs, samlMetadata, samlStart } from "./saml";
import { activeProvider } from "./store";
import { safeRelay } from "./urls";
import { userIdentities } from "@db/schema";
import { and, eq } from "drizzle-orm";
import { getDb } from "../queries/connection";

type C = Context<{ Bindings: HttpBindings }>;
type Ctx = Pick<TrpcContext, "req" | "resHeaders" | "remoteAddress">;

/** What an admin's test sign-in found (Settings shows it): who, and the access they would get. */
export type SsoTestResult = {
  providerId: number;
  at: number;
  ok: boolean;
  failure?: SsoFailure;
  identity?: Identity;
  access?: Resolved;
  linked?: boolean;
};

const g = globalThis as { __iklSsoTests?: Map<number, SsoTestResult> };
/** The last test per admin (in memory: a test is looked at right away). */
export const ssoTests = (g.__iklSsoTests ??= new Map<number, SsoTestResult>());

const ctxOf = (c: C): Ctx => ({ req: c.req.raw, resHeaders: new Headers(), remoteAddress: (c.env as HttpBindings | undefined)?.incoming?.socket?.remoteAddress });

const failed = (c: C, failure: SsoFailure) => c.redirect(`/login?${SSO_FAILURE_PARAM}=${failure}`, 303);

/** The response with the cookies the context set (a session, a remembered device), then the redirect. */
function redirectWith(c: C, ctx: Ctx, to: string) {
  for (const v of ctx.resHeaders.getSetCookie()) c.header("Set-Cookie", v, { append: true });
  return c.redirect(to, 303);
}

async function providerOf(c: C): Promise<IdentityProvider | undefined> {
  const id = Number(c.req.param("id"));
  return Number.isSafeInteger(id) && id > 0 ? activeProvider(id) : undefined;
}

/** Turns a verified identity into a session (or a test result), or says why not. */
async function finish(c: C, ctx: Ctx, p: IdentityProvider, out: { identity: Identity; state: { mode: string; relay: string; userId: number | null } }) {
  const { identity, state } = out;
  if (state.mode === "test") {
    const [link] = await getDb().select({ id: userIdentities.id }).from(userIdentities).where(and(eq(userIdentities.providerId, p.id), eq(userIdentities.subject, identity.subject))).limit(1);
    if (state.userId) ssoTests.set(state.userId, { providerId: p.id, at: Date.now(), ok: true, identity, access: await accessFor(p, identity.groups), linked: Boolean(link) });
    return redirectWith(c, ctx, `/settings/sso?tested=${p.id}`);
  }
  const found = await accountFor(p, identity, ctx);
  if ("failure" in found) {
    await recordSignIn(ctx, { ok: false, method: "sso", username: identity.username, reason: found.failure, userId: found.userId ?? null });
    return failed(c, found.failure);
  }
  await signIn(ctx, found.user, "sso");
  return redirectWith(c, ctx, safeRelay(state.relay));
}

/** A failed sign-in: logged with its detail, recorded, and said (to the admin testing, or on the login page). */
async function failure(c: C, ctx: Ctx, p: IdentityProvider, e: unknown, testerId: number | null) {
  if (!(e instanceof SsoError)) throw e;
  console.warn(`[sso] ${p.name}: ${e.message}`);
  await recordSignIn(ctx, { ok: false, method: "sso", username: "", reason: e.failure });
  if (testerId) {
    ssoTests.set(testerId, { providerId: p.id, at: Date.now(), ok: false, failure: e.failure });
    return c.redirect(`/settings/sso?tested=${p.id}`, 303);
  }
  return failed(c, e.failure);
}

export function registerSsoRoutes(app: Hono<{ Bindings: HttpBindings }>): void {
  app.get("/api/sso/:id/start", async (c) => {
    const p = await providerOf(c);
    if (!p) return failed(c, "unavailable");
    const test = c.req.query("test") === "1";
    let userId: number | null = null;
    if (test) {
      const who = await restUser(c.req.raw, "manageAuth");
      if ("status" in who) return c.json({ error: who.error }, who.status);
      userId = who.user.id;
    }
    const ctx = ctxOf(c);
    const s = { relay: safeRelay(c.req.query("return")), mode: test ? ("test" as const) : ("login" as const), userId };
    try {
      if (p.kind === "saml") return c.redirect((await samlStart(p, s)).url, 302);
      const { url, state } = await oidcStart(p, s);
      ctx.resHeaders.append("Set-Cookie", ssoCookie(c.req.raw, state, SSO_STATE_MINUTES * 60));
      for (const v of ctx.resHeaders.getSetCookie()) c.header("Set-Cookie", v, { append: true });
      return c.redirect(url, 302);
    } catch (e) {
      return failure(c, ctx, p, e, userId);
    }
  });

  app.get("/api/sso/:id/callback", async (c) => {
    const p = await providerOf(c);
    if (!p || p.kind !== "oidc") return failed(c, "unavailable");
    const ctx = ctxOf(c);
    const browserState = readSsoCookie(c.req.raw, parseCookies(c.req.header("cookie") ?? null));
    ctx.resHeaders.append("Set-Cookie", ssoCookie(c.req.raw, "deleted", 0));
    let out: Awaited<ReturnType<typeof oidcCallback>>;
    try {
      out = await oidcCallback(p, new URL(c.req.url).searchParams, browserState);
    } catch (e) {
      return failure(c, ctx, p, e, null);
    }
    return finish(c, ctx, p, out);
  });

  // Exempt from the same-origin check in boot.ts: the provider posts here from its own site.
  app.post("/api/sso/:id/acs", async (c) => {
    const p = await providerOf(c);
    if (!p || p.kind !== "saml") return failed(c, "unavailable");
    const ctx = ctxOf(c);
    const body = await c.req.parseBody().catch((): Record<string, unknown> => ({}));
    const response = typeof body.SAMLResponse === "string" ? body.SAMLResponse : undefined;
    let out: Awaited<ReturnType<typeof samlAcs>>;
    try {
      out = await samlAcs(p, { SAMLResponse: response });
    } catch (e) {
      return failure(c, ctx, p, e, null);
    }
    return finish(c, ctx, p, out);
  });

  app.get("/api/sso/:id/metadata", async (c) => {
    const p = await providerOf(c);
    if (!p || p.kind !== "saml") return c.json({ error: "Not Found" }, 404);
    try {
      return c.body(samlMetadata(p), 200, { "Content-Type": "application/samlmetadata+xml; charset=utf-8", "Content-Disposition": `attachment; filename="inkledger-sp-${p.id}.xml"` });
    } catch (e) {
      if (e instanceof SsoError) return c.json({ error: e.message }, 409);
      throw e;
    }
  });
}

