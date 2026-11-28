import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";

/**
 * SCIM 2.0 as Entra ID and Okta drive it (api/sso/simulators/scim.ts): provisioning, updates,
 * deactivation (sessions gone, never a hard delete, never the last owner), groups as teams,
 * and the bearer token (hashed, per provider; revoked: 401).
 */

process.env.DATABASE_URL = ":memory:";

const q = async <T = Record<string, unknown>>(text: string, ...params: unknown[]) => (await import("../queries/connection")).q<T>(text, ...params);

let call: (path: string, init?: RequestInit) => Promise<Response>;
let sim: ReturnType<typeof import("../sso/simulators/scim").scimSimulator>;
let providerId: number;
const TOKEN = "ikl_scim_test-token-0123456789abcdef";

beforeAll(async () => {
  const { resetDbForTests } = await import("../queries/connection");
  await resetDbForTests();
  const { registerScimRoutes } = await import("./routes");
  const app = new Hono<{ Bindings: HttpBindings }>();
  registerScimRoutes(app);
  call = async (path, init) => app.request(path, init);
  const [{ id }] = await q<{ id: number }>("INSERT INTO identity_providers (kind, name, issuer, created_at) VALUES ('oidc', 'Entra', 'https://login.example/t/v2.0', 1) RETURNING id");
  providerId = id;
  const { sha256Hex } = await import("../lib/hash");
  await q("INSERT INTO scim_tokens (provider_id, token_hash, label, created_at) VALUES (?, ?, 'Entra', 1)", providerId, sha256Hex(TOKEN));
  const { scimSimulator } = await import("../sso/simulators/scim");
  sim = scimSimulator(call, TOKEN);
});

describe("SCIM users", () => {
  it("Entra provisions once (looked up by userName, then created), linked by externalId, no password", async () => {
    const made = await sim.entra.provision({ userName: "ada@example.com", externalId: "oid-ada", displayName: "Ada", email: "ada@example.com" });
    expect(made.status).toBe(201);
    const again = await sim.entra.provision({ userName: "ADA@example.com", externalId: "oid-ada" });
    expect(again.status).toBe(200);
    expect(again.body?.id).toBe(made.body?.id);
    const [row] = await q<{ username: string; auth_source: string; scim_managed: number; password_hash: string | null }>("SELECT username, auth_source, scim_managed, password_hash FROM users WHERE id = ?", Number(made.body?.id));
    expect(row).toEqual({ username: "ada", auth_source: "scim", scim_managed: 1, password_hash: null });
    expect(await q("SELECT subject FROM user_identities WHERE user_id = ?", Number(made.body?.id))).toEqual([{ subject: "oid-ada" }]);
  });

  it("deactivation (Entra's string boolean) turns the account off and ends its sessions; DELETE never removes it", async () => {
    const made = await sim.okta.create({ userName: "bob@example.com", externalId: "oid-bob" });
    const id = Number(made.body?.id);
    await q("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('sess-bob', ?, ?, 1)", id, Date.now() + 3_600_000);
    expect((await sim.entra.setActive(String(id), false)).status).toBe(200);
    expect(await q("SELECT count(*)::int AS n FROM sessions WHERE user_id = ?", id)).toEqual([{ n: 0 }]);
    expect((await q<{ off: boolean }>("SELECT disabled_at IS NOT NULL AS off FROM users WHERE id = ?", id))[0].off).toBe(true);
    expect((await sim.entra.setActive(String(id), true)).body?.active).toBe(true);
    expect((await sim.remove(String(id))).status).toBe(204);
    expect(await q("SELECT count(*)::int AS n FROM users WHERE id = ? AND disabled_at IS NOT NULL", id)).toEqual([{ n: 1 }]);
  });

  it("the last owner can't be deactivated", async () => {
    const made = await sim.okta.create({ userName: "root@example.com" });
    const id = Number(made.body?.id);
    await q("UPDATE users SET disabled_at = 1 WHERE role = 'admin' AND id <> ?", id);
    await q("UPDATE users SET role = 'admin' WHERE id = ?", id);
    const out = await sim.okta.deactivate(String(id));
    expect(out.status).toBe(400);
    expect(out.body?.scimType).toBe("mutability");
    expect((await q<{ off: boolean }>("SELECT disabled_at IS NOT NULL AS off FROM users WHERE id = ?", id))[0].off).toBe(false);
  });

  it("accounts made any other way are invisible to SCIM (no takeover of a local account)", async () => {
    const [{ id }] = await q<{ id: number }>("INSERT INTO users (username, display_name, created_at) VALUES ('local1', 'Local', 1) RETURNING id");
    expect((await sim.send("GET", `/Users/${id}`)).status).toBe(404);
    expect((await sim.okta.deactivate(String(id))).status).toBe(404);
  });

  it("filters other than attribute eq value are refused", async () => {
    const out = await sim.send("GET", `/Users?filter=${encodeURIComponent('userName co "a"')}`);
    expect(out.status).toBe(400);
    expect(out.body?.scimType).toBe("invalidFilter");
  });
});

describe("SCIM groups", () => {
  it("a group becomes a team; members follow Entra's add and remove", async () => {
    const g = await sim.entra.createGroup("Platform", "grp-platform");
    expect(g.status).toBe(201);
    const u = await sim.okta.create({ userName: "carol@example.com" });
    await sim.entra.addMember(String(g.body?.id), String(u.body?.id));
    expect(await q("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?", Number(g.body?.id), Number(u.body?.id))).toEqual([{ role: "member" }]);
    await sim.entra.removeMember(String(g.body?.id), String(u.body?.id));
    expect(await q("SELECT count(*)::int AS n FROM team_members WHERE team_id = ?", Number(g.body?.id))).toEqual([{ n: 0 }]);
  });
});

describe("SCIM addresses", () => {
  it("meta.location and Location are absolute under PUBLIC_URL, the path alone while it is unset", async () => {
    const { scimUrl } = await import("./resources");
    expect(scimUrl("/Users/8", null)).toBe("/scim/v2/Users/8");
    expect(scimUrl("/Users/8", "https://time.example.com")).toBe("https://time.example.com/scim/v2/Users/8");
    expect(scimUrl("/Groups/3", "https://example.com/ikl/")).toBe("https://example.com/ikl/scim/v2/Groups/3");
    const { env } = await import("../lib/env");
    const was = env.publicUrl;
    try {
      env.publicUrl = null;
      const relative = await sim.okta.create({ userName: "rel@example.com" });
      expect((relative.body?.meta as { location?: string } | undefined)?.location).toBe(`/scim/v2/Users/${String(relative.body?.id)}`);
      env.publicUrl = "https://time.example.com";
      const res = await call("/scim/v2/Users", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/scim+json" }, body: JSON.stringify({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "abs@example.com" }) });
      expect(res.status).toBe(201);
      const made = (await res.json()) as { id: string; meta: { location: string } };
      expect(made.meta.location).toBe(`https://time.example.com/scim/v2/Users/${made.id}`);
      expect(res.headers.get("location")).toBe(made.meta.location);
      const group = (await (await call(`/scim/v2/Groups`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/scim+json" }, body: JSON.stringify({ displayName: "Absolute" }) })).json()) as { id: string; meta: { location: string } };
      expect(group.meta.location).toBe(`https://time.example.com/scim/v2/Groups/${group.id}`);
      const types = (await (await call("/scim/v2/ResourceTypes", { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { Resources: { meta: { location: string } }[] };
      expect(types.Resources.map((r) => r.meta.location)).toEqual(["https://time.example.com/scim/v2/ResourceTypes/User", "https://time.example.com/scim/v2/ResourceTypes/Group"]);
    } finally {
      env.publicUrl = was;
    }
  });
});

describe("SCIM tokens", () => {
  it("no token, a wrong one or a revoked one: 401; every write is audited as scim", async () => {
    expect((await call("/scim/v2/Users")).status).toBe(401);
    expect((await call("/scim/v2/Users", { headers: { authorization: "Bearer ikl_scim_wrong-token-000000000" } })).status).toBe(401);
    const { flushAudit } = await import("../lib/audit");
    await flushAudit();
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE actor_kind = 'scim' AND action LIKE 'scim.%'"))[0].n).toBeGreaterThan(0);
    await q("UPDATE scim_tokens SET revoked_at = 1 WHERE provider_id = ?", providerId);
    expect((await sim.send("GET", "/Users")).status).toBe(401);
  });
});
