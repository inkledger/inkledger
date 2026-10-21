// Tests: a signed-in account with its Jira connected, as a Jira login used
// to make one: Jira confirms the login (one /myself call), the account for
// that Jira account is found through its connection or made with one (the
// secret sealed for it), and the session cookie lands on resHeaders.
// Everything is imported when called: test files set process.env first.
import type { JiraLoginInput } from "../lib/jiraLogin";

type Input = Omit<JiraLoginInput, "deployment" | "authType"> & Partial<Pick<JiraLoginInput, "deployment" | "authType">>;

export async function jiraSignIn(ctx: { req: Request; resHeaders: Headers }, input: Input) {
  const { connections, sessions, users } = await import("@db/schema");
  const { and, eq } = await import("drizzle-orm");
  const { getDb } = await import("../queries/connection");
  const { newSessionId } = await import("../lib/crypto");
  const { hashSessionId } = await import("../lib/security");
  const { sessionCookie } = await import("../lib/session");
  const { confirmJiraLogin, jiraLoginInput } = await import("../lib/jiraLogin");
  const { storeSecret } = await import("../providers/connections");
  const { publicUser } = await import("../routers/auth");

  const identity = await confirmJiraLogin(jiraLoginInput.parse(input));
  const db = getDb();
  const [known] = await db
    .select({ user: users, connectionId: connections.id })
    .from(connections)
    .innerJoin(users, eq(users.id, connections.userId))
    .where(and(eq(connections.type, "jira"), eq(connections.baseUrl, identity.siteUrl), eq(connections.remoteAccountId, identity.accountId)))
    .limit(1);
  const profile = { displayName: identity.displayName, email: identity.email, avatarUrl: identity.avatarUrl };
  // Accounts made by a Jira login predate local accounts: the migration made them admins.
  const [user] = known
    ? await db.update(users).set(profile).where(eq(users.id, known.user.id)).returning()
    : await db.insert(users).values({ ...profile, role: "admin" }).returning();
  const connectionId =
    known?.connectionId ??
    (
      await db
        .insert(connections)
        .values({
          userId: user.id,
          type: "jira",
          baseUrl: identity.siteUrl,
          remoteAccountId: identity.accountId,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
          options: JSON.stringify({ deployment: identity.deployment, authType: identity.authType, username: identity.email }),
          encryptedSecret: "",
          legacy: 1,
        })
        .returning({ id: connections.id })
    )[0].id;
  await storeSecret(connectionId, identity.secret);
  const cookie = newSessionId();
  await db.insert(sessions).values({ id: hashSessionId(cookie), userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) });
  ctx.resHeaders.append("Set-Cookie", sessionCookie(ctx.req, cookie, 86_400));
  return publicUser(user);
}
