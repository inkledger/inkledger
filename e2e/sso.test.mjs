// Single sign-on in the browser, against the simulated OpenID Connect provider
// (api/sso/simulators/oidc.ts served over http on this machine: SSO_ALLOW_LOCAL_IDP=1):
// the login page's button, an account made at first sign-in (JIT), enforcement hiding the
// password form, and a break-glass owner still signing in with a password.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tsImport } from "tsx/esm/api";
import { withApp } from "./harness.mjs";

/** The simulated provider on a port of its own: its fetch handler answers real HTTP requests. */
async function serveIdp() {
  const { oidcSimulator } = await tsImport("../api/sso/simulators/oidc.ts", import.meta.url);
  let sim = null;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined;
    const answer = await sim.fetch(`${sim.issuer}${req.url}`, { method: req.method, headers: req.headers, body });
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  sim = await oidcSimulator({ issuer: `http://127.0.0.1:${port}`, clientId: "inkledger-e2e", clientSecret: null });
  sim.state.user = { sub: "e2e-ada", email: "ada@example.com", name: "Ada Lovelace", preferred_username: "ada@example.com", groups: ["staff"] };
  return { sim, close: () => new Promise(r => server.close(r)) };
}

test("single sign-on: JIT account at first sign-in; enforced, only break-glass owners see the password form", async () => {
  const idp = await serveIdp();
  try {
    await withApp({ bare: true, env: ({ base }) => ({ PUBLIC_URL: base, SSO_ALLOW_LOCAL_IDP: "1", PROVIDERS_READ_ONLY: "1" }) }, async ({ page, base, db, context }) => {
      const now = Date.now();
      const [{ id }] = await db.q(
        "INSERT INTO identity_providers (kind, name, issuer, client_id, jit_enabled, created_at) VALUES ('oidc', 'Corp IdP', ?, 'inkledger-e2e', 1, ?) RETURNING id",
        idp.sim.issuer,
        now,
      );

      // The login page offers the provider; its button goes there and back, signed in.
      await page.goto(base + "/login");
      await page.getByRole("link", { name: "Sign in with Corp IdP" }).click();
      await page.waitForURL(url => !/^\/(login|api\/)/.test(new URL(url).pathname));
      const [made] = await db.q("SELECT u.username, u.auth_source, u.password_hash FROM users u JOIN user_identities i ON i.user_id = u.id WHERE i.provider_id = ? AND i.subject = 'e2e-ada'", id);
      assert.deepEqual(made, { username: "ada", auth_source: "sso", password_hash: null });

      // Enforced, with the server's admin as break-glass owner.
      await db.q("UPDATE users SET break_glass = 1 WHERE username = 'admin'");
      await db.q("UPDATE identity_providers SET enforced = 1 WHERE id = ?", id);
      const fresh = await context.browser().newContext({ locale: "en-US" });
      try {
        const other = await fresh.newPage();
        await other.goto(base + "/login");
        await other.getByText("Your organization signs in through single sign-on.").waitFor();
        assert.equal(await other.getByLabel("Password").count(), 0, "no password form while enforced");
        await other.getByRole("button", { name: "Sign in with a password (break-glass accounts)" }).click();
        await other.getByLabel("Username").fill("admin");
        await other.getByLabel("Password").fill("admin");
        await other.getByRole("button", { name: "Sign in", exact: true }).click();
        // In: a new server's admin must choose a new password first.
        await other.getByRole("heading", { name: "Choose a new password" }).waitFor();
      } finally {
        await fresh.close();
      }

      // The account the provider made can't use a password, enforced or not.
      const refused = await fetch(`${base}/api/trpc/auth.login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ json: { username: "ada", password: "whatever-long-enough" } }),
      });
      assert.equal(refused.status, 403);
    });
  } finally {
    await idp.close();
  }
});

test("single sign-on: a failed sign-in comes back to the login page and says why", async () => {
  const idp = await serveIdp();
  try {
    idp.sim.state.deny = true;
    await withApp({ bare: true, env: ({ base }) => ({ PUBLIC_URL: base, SSO_ALLOW_LOCAL_IDP: "1", PROVIDERS_READ_ONLY: "1" }) }, async ({ page, base, db }) => {
      await db.q("INSERT INTO identity_providers (kind, name, issuer, client_id, jit_enabled, created_at) VALUES ('oidc', 'Corp IdP', ?, 'inkledger-e2e', 1, ?)", idp.sim.issuer, Date.now());
      await page.goto(base + "/login");
      await page.getByRole("link", { name: "Sign in with Corp IdP" }).click();
      await page.waitForURL(url => new URL(url).pathname === "/login");
      await page.getByText("The identity provider didn't sign you in.").waitFor();
    });
  } finally {
    await idp.close();
  }
});
