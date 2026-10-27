// The connections a user works with (a Jira site today, more providers to
// come), and the credentials each one opens. Everything that talks to a
// tracker gets its credentials here, never from the user row.
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { connections, issues, type Connection, type User } from "@db/schema";
import type { JiraCredentials } from "@contracts/types";
import type { TrackerType } from "@contracts/providers";
import { instant, timeZone } from "@contracts/values";
import type { StoredConn } from "./core/bind";
import { originate } from "./core/origin";
import { getDb } from "../queries/connection";
import { openSecret, sealSecret } from "../lib/crypto";
import { singleFlight } from "../lib/locks";
import { UnreadableCredentialsError } from "../middleware";
import { t } from "@contracts/i18n";
import {
  parseGitHubTokenSet,
  refreshGitHubTokenSet,
  serializeGitHubTokenSet,
  type GitHubTokenSet,
} from "./github/oauth";

/** The user has no live connection of the kind needed (a new account, or all of them archived). */
export class NoConnectionError extends Error {
  constructor() {
    super(t("server.auth.noConnection"));
    this.name = "NoConnectionError";
  }
}

/**
 * The user's Jira connection while there is one per user: the one made from
 * their login first (legacy), then the oldest.
 */
export async function jiraConnection(
  userId: number
): Promise<Connection | null> {
  const [row] = await getDb()
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.userId, userId),
        eq(connections.type, "jira"),
        isNull(connections.archivedAt)
      )
    )
    .orderBy(desc(connections.legacy), asc(connections.id))
    .limit(1);
  return row ?? null;
}

type JiraOptions = {
  deployment?: string;
  authType?: string;
  username?: string;
};

function jiraOptions(raw: string): JiraOptions {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A connection's secret in clear. One that no key opens any more (the
 * credentials key changed) is unreadable: the connection asks to be
 * reconnected (protectedProcedure); the session stays.
 */
function secretOf(conn: Pick<Connection, "id" | "encryptedSecret">): string {
  try {
    return openSecret(conn.encryptedSecret, conn.id).plain;
  } catch {
    const cause = originate(new UnreadableCredentialsError(), conn.id);
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: cause.message,
      cause,
    });
  }
}

/** A connection's new secret, sealed for it. */
export async function storeSecret(
  connectionId: number,
  plain: string
): Promise<void> {
  await getDb()
    .update(connections)
    .set({ encryptedSecret: sealSecret(plain, connectionId) })
    .where(eq(connections.id, connectionId));
}

const GITHUB_REFRESH_MARGIN_MS = 5 * 60_000;
const usableGitHubToken = (tokens: GitHubTokenSet) =>
  tokens.accessTokenExpiresAt === null ||
  tokens.accessTokenExpiresAt > Date.now() + GITHUB_REFRESH_MARGIN_MS;
type GitHubSecret = {
  tokens: GitHubTokenSet;
  encryptedSecret: string;
  rotated: boolean;
};
const githubRefreshes = singleFlight<number, GitHubSecret>();

export async function storeGitHubTokenSet(
  connectionId: number,
  tokens: GitHubTokenSet
): Promise<void> {
  const encryptedSecret = sealSecret(
    serializeGitHubTokenSet(tokens),
    connectionId
  );
  await getDb().transaction(async tx => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('github-oauth-refresh'), ${connectionId})`
    );
    await tx
      .update(connections)
      .set({ encryptedSecret })
      .where(eq(connections.id, connectionId));
  });
}

async function gitHubSecretOf(
  row: Pick<Connection, "id" | "encryptedSecret">,
  mode: "ifExpired" | "force",
  rejectedAccessToken?: string
): Promise<GitHubSecret> {
  const initial = parseGitHubTokenSet(secretOf(row));
  if (mode === "ifExpired" && usableGitHubToken(initial)) {
    return {
      tokens: initial,
      encryptedSecret: row.encryptedSecret,
      rotated:
        rejectedAccessToken !== undefined &&
        initial.accessToken !== rejectedAccessToken,
    };
  }
  const result = await githubRefreshes.run(row.id, () =>
    getDb().transaction(async tx => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('github-oauth-refresh'), ${row.id})`
      );
      const [currentRow] = await tx
        .select({
          id: connections.id,
          encryptedSecret: connections.encryptedSecret,
        })
        .from(connections)
        .where(eq(connections.id, row.id))
        .limit(1);
      if (!currentRow)
        return {
          tokens: initial,
          encryptedSecret: row.encryptedSecret,
          rotated: false,
        };
      const current = parseGitHubTokenSet(secretOf(currentRow));
      if (
        rejectedAccessToken !== undefined &&
        current.accessToken !== rejectedAccessToken
      ) {
        return {
          tokens: current,
          encryptedSecret: currentRow.encryptedSecret,
          rotated: true,
        };
      }
      if (mode === "ifExpired" && usableGitHubToken(current))
        return {
          tokens: current,
          encryptedSecret: currentRow.encryptedSecret,
          rotated: false,
        };
      if (!current.refreshToken)
        return {
          tokens: current,
          encryptedSecret: currentRow.encryptedSecret,
          rotated: false,
        };
      const tokens = await refreshGitHubTokenSet(current);
      const encryptedSecret = sealSecret(
        serializeGitHubTokenSet(tokens),
        row.id
      );
      await tx
        .update(connections)
        .set({ encryptedSecret })
        .where(eq(connections.id, row.id));
      return { tokens, encryptedSecret, rotated: true };
    })
  );
  return {
    ...result,
    rotated:
      result.rotated ||
      (rejectedAccessToken !== undefined &&
        result.tokens.accessToken !== rejectedAccessToken),
  };
}

/** The credentials a Jira connection opens (its secret in clear). */
export function credentialsOf(conn: Connection): JiraCredentials {
  const o = jiraOptions(conn.options);
  const secret = secretOf(conn);
  return originate(
    {
      siteUrl: conn.baseUrl,
      deployment: o.deployment === "server" ? "server" : "cloud",
      authType: o.authType === "bearer" ? "bearer" : "basic",
      // Login identifier: email (Cloud) or username (Server/DC)
      username: o.username ?? "",
      secret,
    },
    conn.id
  );
}

/** The user's Jira credentials, from their Jira connection. */
export async function jiraCredentials(user: {
  id: number;
}): Promise<JiraCredentials> {
  const conn = await jiraConnection(user.id);
  if (!conn) {
    const cause = new NoConnectionError();
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: cause.message,
      cause,
    });
  }
  return credentialsOf(conn);
}

/** A connection as stored, ready to bind to its provider: options still raw, the secret decrypted on use. */
export function connOf(row: Connection): StoredConn<TrackerType> {
  let options: unknown = {};
  try {
    options = JSON.parse(row.options) as unknown;
  } catch {
    /* the provider's parseOptions refuses it */
  }
  let encryptedSecret = row.encryptedSecret;
  const github = row.type === "github";
  const secretRow = () => ({ id: row.id, encryptedSecret });
  return {
    id: row.id,
    userId: row.userId,
    type: row.type as TrackerType,
    baseUrl: row.baseUrl,
    remoteAccountId: row.remoteAccountId,
    options,
    // The server runs in the user's zone (TZ, api/lib/tz.ts).
    timeZone: timeZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
    credential: github
      ? async () => {
          const secret = await gitHubSecretOf(secretRow(), "ifExpired");
          encryptedSecret = secret.encryptedSecret;
          return {
            kind: "oauth",
            accessToken: secret.tokens.accessToken,
            expiresAt:
              secret.tokens.accessTokenExpiresAt === null
                ? null
                : instant(secret.tokens.accessTokenExpiresAt),
          };
        }
      : async () => ({ kind: "token", token: secretOf(row) }),
    ...(github
      ? {
          refreshCredential: async (
            mode: "ifExpired" | "force",
            rejectedAccessToken?: string
          ) => {
            const secret = await gitHubSecretOf(
              secretRow(),
              mode,
              rejectedAccessToken
            );
            encryptedSecret = secret.encryptedSecret;
            return secret.rotated;
          },
        }
      : {}),
  };
}

/** A user as Jira sees them: site and account from their Jira connection. */
export type JiraUser = User & {
  siteUrl: string;
  accountId: string;
  connectionId: number;
};

/** One connection's Jira side: who the user is there, and the credentials to call it. */
export function contextFor(
  user: User,
  conn: Connection
): { user: JiraUser; creds: JiraCredentials; conn: Connection } {
  return {
    user: {
      ...user,
      siteUrl: conn.baseUrl,
      accountId: conn.remoteAccountId,
      connectionId: conn.id,
    },
    creds: credentialsOf(conn),
    conn,
  };
}

/** One of the user's live connections, by id (never someone else's). */
export async function ownConnection(
  userId: number,
  connectionId: number
): Promise<Connection> {
  const [row] = await getDb()
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.userId, userId),
        isNull(connections.archivedAt)
      )
    )
    .limit(1);
  if (!row)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: t("server.connections.notFound"),
    });
  return row;
}

/**
 * The connection an issue lives on: the one asked for; else the one whose
 * catalogue has that key; else (an issue not imported yet, a key typed) the
 * user's primary Jira. Two connections with the key and none asked for:
 * ambiguous, never guessed.
 */
export async function issueConnection(
  userId: number,
  key: string,
  connectionId?: number
): Promise<Connection> {
  if (connectionId !== undefined) return ownConnection(userId, connectionId);
  const owners = await getDb()
    .selectDistinct({ conn: connections })
    .from(issues)
    .innerJoin(connections, eq(connections.id, issues.connectionId))
    .where(
      and(
        eq(issues.userId, userId),
        eq(issues.key, key),
        isNull(connections.archivedAt)
      )
    );
  if (owners.length === 1) return owners[0].conn;
  if (owners.length > 1)
    throw new TRPCError({
      code: "CONFLICT",
      message: t("server.connections.ambiguousKey", { key }),
    });
  const primary = await jiraConnection(userId);
  if (!primary) {
    const cause = new NoConnectionError();
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: cause.message,
      cause,
    });
  }
  return primary;
}

/** The Jira side of the connection an issue lives on (see issueConnection). */
export async function jiraContextFor(
  user: User,
  key: string,
  connectionId?: number
) {
  return contextFor(user, await issueConnection(user.id, key, connectionId));
}

/** The user's live Jira connections (each syncs and replays on its own). */
export async function jiraConnections(userId: number): Promise<Connection[]> {
  return getDb()
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.userId, userId),
        eq(connections.type, "jira"),
        isNull(connections.archivedAt)
      )
    )
    .orderBy(desc(connections.legacy), asc(connections.id));
}

/** The user's own ids on their trackers (who "me" is in an issue's assignee). */
export async function myRemoteIds(userId: number): Promise<string[]> {
  const rows = await getDb()
    .select({ id: connections.remoteAccountId })
    .from(connections)
    .where(and(eq(connections.userId, userId), isNull(connections.archivedAt)));
  return rows.map(r => r.id);
}

/**
 * One connection can't be used as saved (refused credentials, or a secret
 * that no longer decrypts), or works again ("ok"). Its type comes back, to
 * name its service.
 */
export async function markConnection(
  userId: number,
  connectionId: number,
  status: "ok" | "auth_failed" | "unreadable"
): Promise<string | null> {
  const [row] = await getDb()
    .update(connections)
    .set({ status })
    .where(
      and(eq(connections.id, connectionId), eq(connections.userId, userId))
    )
    .returning({ type: connections.type });
  return row?.type ?? null;
}

/**
 * The user's Jira connection can't be used as saved: refused credentials
 * (auth_failed) or a secret that no longer decrypts (unreadable). It waits
 * for the user to reconnect it; the account stays signed in. "ok" again
 * once reconnected.
 */
export async function markJiraConnection(
  userId: number,
  status: "ok" | "auth_failed" | "unreadable"
) {
  await getDb()
    .update(connections)
    .set({ status })
    .where(
      and(
        eq(connections.userId, userId),
        eq(connections.type, "jira"),
        isNull(connections.archivedAt)
      )
    );
}
