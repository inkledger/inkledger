// SCIM 2.0 over HTTP (/scim/v2): the identity provider creates, updates and turns off
// accounts, and keeps teams in step with its groups. Bearer tokens are per provider and kept
// only as their hash; a revoked one, or one of a provider turned off, gets 401. Every write is
// an audit event by "scim", a refused one too (outcome "denied", with its status and scimType).
// Rate-limited per token (api/ops/routes.ts).
import type { Context, Hono, Next } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { identityProviders, scimTokens, type IdentityProvider, type User } from "@db/schema";
import { SCIM_BASE } from "@contracts/sso";
import type { AuditAction } from "@contracts/audit";
import { getDb } from "../queries/connection";
import { sha256Hex } from "../lib/hash";
import { recordAs } from "../lib/audit";
import { inMaintenance } from "../lib/maintenance";
import { t } from "@contracts/i18n";
import {
  createGroup,
  createUser,
  deactivate,
  deleteGroup,
  GROUP_SCHEMA,
  groupResource,
  listGroups,
  listUsers,
  patchGroup,
  replaceGroup,
  scimGroupById,
  ScimError,
  scimUrl,
  scimUserById,
  updateUser,
  USER_SCHEMA,
  userFields,
  userPatch,
  userResource,
} from "./resources";

type C = Context<{ Bindings: HttpBindings }>;
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_JSON = "application/scim+json";

const send = (c: C, body: unknown, status: 200 | 201 = 200) => c.body(JSON.stringify(body), status, { "Content-Type": SCIM_JSON });
const error = (c: C, status: number, detail: string, scimType?: string) =>
  c.body(JSON.stringify({ schemas: [ERROR_SCHEMA], status: String(status), detail, ...(scimType ? { scimType } : {}) }), status as 400, { "Content-Type": SCIM_JSON });

/** The provider a bearer token belongs to: known by its hash, not revoked, provider on. */
export async function tokenProvider(header: string | undefined): Promise<{ provider: IdentityProvider; tokenId: number } | null> {
  const m = /^Bearer\s+(\S{16,256})$/i.exec(header ?? "");
  if (!m) return null;
  const [row] = await getDb()
    .select({ provider: identityProviders, tokenId: scimTokens.id })
    .from(scimTokens)
    .innerJoin(identityProviders, eq(identityProviders.id, scimTokens.providerId))
    .where(and(eq(scimTokens.tokenHash, sha256Hex(m[1])), isNull(scimTokens.revokedAt), isNull(identityProviders.disabledAt)))
    .limit(1);
  if (!row) return null;
  // When it was last used, at most once a minute (Settings shows it).
  const now = Date.now();
  await getDb()
    .update(scimTokens)
    .set({ lastUsedAt: new Date(now) })
    .where(and(eq(scimTokens.id, row.tokenId), or(isNull(scimTokens.lastUsedAt), lt(scimTokens.lastUsedAt, new Date(now - 60_000)))));
  return row;
}

async function body(c: C): Promise<Record<string, unknown>> {
  try {
    const v: unknown = await c.req.json();
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // said below
  }
  throw new ScimError(400, "The body is not a JSON object", "invalidSyntax");
}

const userTarget = (u: User) => ({ type: "user", id: u.id, ownerUserId: u.id });

const serviceProviderConfig = () => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token", description: "A token made in Settings > Single sign-on", primary: true }],
  meta: { resourceType: "ServiceProviderConfig", location: scimUrl("/ServiceProviderConfig") },
});

const attr = (name: string, type: string, o: Record<string, unknown> = {}) => ({ name, type, multiValued: false, required: false, caseExact: false, mutability: "readWrite", returned: "default", uniqueness: "none", ...o });

const schemas = () => [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: USER_SCHEMA,
    name: "User",
    description: "An account",
    attributes: [
      attr("userName", "string", { required: true, uniqueness: "server" }),
      attr("name", "complex", { subAttributes: [attr("formatted", "string"), attr("givenName", "string"), attr("familyName", "string")] }),
      attr("displayName", "string"),
      attr("emails", "complex", { multiValued: true, subAttributes: [attr("value", "string"), attr("type", "string"), attr("primary", "boolean")] }),
      attr("active", "boolean"),
      attr("externalId", "string", { caseExact: true }),
      attr("groups", "complex", { multiValued: true, mutability: "readOnly", subAttributes: [attr("value", "string"), attr("display", "string")] }),
    ],
    meta: { resourceType: "Schema", location: scimUrl(`/Schemas/${USER_SCHEMA}`) },
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: GROUP_SCHEMA,
    name: "Group",
    description: "A team",
    attributes: [
      attr("displayName", "string", { required: true, uniqueness: "server" }),
      attr("externalId", "string", { caseExact: true }),
      attr("members", "complex", { multiValued: true, subAttributes: [attr("value", "string"), attr("display", "string")] }),
    ],
    meta: { resourceType: "Schema", location: scimUrl(`/Schemas/${GROUP_SCHEMA}`) },
  },
];

const resourceTypes = () => [
  { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER_SCHEMA, meta: { resourceType: "ResourceType", location: scimUrl("/ResourceTypes/User") } },
  { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP_SCHEMA, meta: { resourceType: "ResourceType", location: scimUrl("/ResourceTypes/Group") } },
];

const list = (resources: unknown[]) => ({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources });

/** The token's provider, per request (set by the middleware below). */
const callers = new WeakMap<Request, { provider: IdentityProvider; tokenId: number }>();
/** A write that turned out to be another action than its route's (a PUT or PATCH turning an account off), per request. */
const intents = new WeakMap<Request, AuditAction>();

/** A handler whose refusals (ScimError) are answered in SCIM's error format. */
const h = (fn: (c: C) => Promise<Response> | Response) => async (c: C) => {
  try {
    return await fn(c);
  } catch (e) {
    if (e instanceof ScimError) return error(c, e.status, e.message, e.scimType);
    throw e;
  }
};

export function registerScimRoutes(app: Hono<{ Bindings: HttpBindings }>): void {
  const scim = app.basePath(SCIM_BASE);

  scim.use("*", async (c: C, next: Next) => {
    // A restore replacing the database: no write lands meanwhile.
    if (inMaintenance() && c.req.method !== "GET") return error(c, 503, t("server.maintenance"));
    const found = await tokenProvider(c.req.header("authorization"));
    if (!found) return error(c, 401, "A valid bearer token is required");
    callers.set(c.req.raw, found);
    await next();
  });

  const who = (c: C) => {
    const found = callers.get(c.req.raw);
    if (!found) throw new ScimError(401, "A valid bearer token is required");
    return found;
  };
  const audit = (c: C, action: AuditAction, details: Parameters<typeof recordAs>[3]) => {
    const { provider, tokenId } = who(c);
    return recordAs({ kind: "scim", label: `${provider.name} (token ${tokenId})` }, { req: c.req.raw, remoteAddress: (c.env as HttpBindings | undefined)?.incoming?.socket?.remoteAddress }, action, details);
  };
  /**
   * A write whose refusal (ScimError: an invalid payload, a name taken, the last owner, an
   * account SCIM can't see) is an event too: the action it would have been, outcome "denied",
   * and only the status and scimType kept (the detail may echo the payload).
   */
  const write = (action: AuditAction, type: "user" | "team", fn: (c: C) => Promise<Response>) => async (c: C) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof ScimError) {
        const id = c.req.param("id") ?? "";
        await audit(c, intents.get(c.req.raw) ?? action, { outcome: "denied", target: { type, id: /^\d{1,12}$/.test(id) ? Number(id) : null }, after: { status: e.status, ...(e.scimType ? { scimType: e.scimType } : {}) } });
      }
      throw e;
    }
  };

  scim.get("/ServiceProviderConfig", h((c) => send(c, serviceProviderConfig())));
  scim.get("/Schemas", h((c) => send(c, list(schemas()))));
  scim.get("/Schemas/:id", h((c) => {
    const s = schemas().find((x) => x.id === c.req.param("id"));
    return s ? send(c, s) : error(c, 404, "Schema not found");
  }));
  scim.get("/ResourceTypes", h((c) => send(c, list(resourceTypes()))));

  scim.get("/Users", h(async (c) => send(c, await listUsers(c.req.query()))));
  scim.get("/Users/:id", h(async (c) => send(c, await userResource(await scimUserById(c.req.param("id") ?? "")))));
  scim.post("/Users", h(write("scim.createUser", "user", async (c) => {
    const u = await createUser(who(c), await body(c));
    await audit(c, "scim.createUser", { target: userTarget(u), after: { username: u.username, userName: u.scimUserName, active: !u.disabledAt } });
    c.header("Location", scimUrl(`/Users/${u.id}`));
    return send(c, await userResource(u), 201);
  })));
  const update = async (c: C, fields: ReturnType<typeof userFields>, action: "scim.replaceUser" | "scim.patchUser") => {
    if (fields.active === false) intents.set(c.req.raw, "scim.deactivateUser");
    const u = await scimUserById(c.req.param("id") ?? "");
    const out = await updateUser(u, fields);
    await audit(c, out.deactivated ? "scim.deactivateUser" : out.reactivated ? "scim.reactivateUser" : action, { target: userTarget(out.user), before: { username: u.username, userName: u.scimUserName, active: !u.disabledAt }, after: { username: out.user.username, userName: out.user.scimUserName, active: !out.user.disabledAt } });
    return send(c, await userResource(out.user));
  };
  scim.put("/Users/:id", h(write("scim.replaceUser", "user", async (c) => update(c, userFields(await body(c)), "scim.replaceUser"))));
  scim.patch("/Users/:id", h(write("scim.patchUser", "user", async (c) => update(c, userPatch((await body(c)).Operations), "scim.patchUser"))));
  // Never a hard delete (erasure is another matter): the account is turned off and signed out.
  scim.delete("/Users/:id", h(write("scim.deactivateUser", "user", async (c) => {
    const u = await scimUserById(c.req.param("id") ?? "");
    const out = u.disabledAt ? u : await deactivate(u);
    await audit(c, "scim.deactivateUser", { target: userTarget(out), before: { username: u.username, active: !u.disabledAt }, after: { username: out.username, active: false } });
    return c.body(null, 204);
  })));

  scim.get("/Groups", h(async (c) => send(c, await listGroups(c.req.query()))));
  scim.get("/Groups/:id", h(async (c) => send(c, await groupResource(await scimGroupById(c.req.param("id") ?? "")))));
  scim.post("/Groups", h(write("scim.createGroup", "team", async (c) => {
    const team = await createGroup(await body(c));
    await audit(c, "scim.createGroup", { target: { type: "team", id: team.id }, after: { name: team.name } });
    c.header("Location", scimUrl(`/Groups/${team.id}`));
    return send(c, await groupResource(team), 201);
  })));
  scim.put("/Groups/:id", h(write("scim.updateGroup", "team", async (c) => {
    const before = await scimGroupById(c.req.param("id") ?? "");
    const team = await replaceGroup(before, await body(c));
    await audit(c, "scim.updateGroup", { target: { type: "team", id: team.id }, before: { name: before.name }, after: { name: team.name } });
    return send(c, await groupResource(team));
  })));
  scim.patch("/Groups/:id", h(write("scim.updateGroup", "team", async (c) => {
    const before = await scimGroupById(c.req.param("id") ?? "");
    const team = await patchGroup(before, (await body(c)).Operations);
    await audit(c, "scim.updateGroup", { target: { type: "team", id: team.id }, before: { name: before.name }, after: { name: team.name } });
    return send(c, await groupResource(team));
  })));
  scim.delete("/Groups/:id", h(write("scim.deleteGroup", "team", async (c) => {
    const team = await scimGroupById(c.req.param("id") ?? "");
    await deleteGroup(team);
    await audit(c, "scim.deleteGroup", { target: { type: "team", id: team.id }, before: { name: team.name } });
    return c.body(null, 204);
  })));

  scim.all("*", h((c) => error(c, 404, "Not found")));
}

