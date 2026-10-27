import { env } from "../../lib/env";
import { kindOfStatus, normalizeError, ProviderError } from "../core/errors";
import { safeFetch } from "../core/http";

export type GitHubTokenSet = {
  v: 1;
  accessToken: string;
  accessTokenExpiresAt: number | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: number | null;
};

export type GitHubOAuthResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
};

const expiry = (seconds: number | undefined, now: number): number | null =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? now + Math.trunc(seconds * 1000)
    : null;

export function gitHubTokenSetFromResponse(
  r: GitHubOAuthResponse,
  now = Date.now()
): GitHubTokenSet {
  if (!r.access_token)
    throw new ProviderError(
      "invalid",
      "GitHub OAuth answer has no access token"
    );
  return {
    v: 1,
    accessToken: r.access_token,
    accessTokenExpiresAt: expiry(r.expires_in, now),
    refreshToken: r.refresh_token ?? null,
    refreshTokenExpiresAt: expiry(r.refresh_token_expires_in, now),
  };
}

export function serializeGitHubTokenSet(tokens: GitHubTokenSet): string {
  return JSON.stringify(tokens);
}

const nullableInstant = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isInteger(value) && value >= 0);

export function parseGitHubTokenSet(plain: string): GitHubTokenSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain) as unknown;
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("v" in parsed)
  ) {
    return {
      v: 1,
      accessToken: plain,
      accessTokenExpiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    };
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.v !== 1 ||
    typeof candidate.accessToken !== "string" ||
    candidate.accessToken.length === 0 ||
    !nullableInstant(candidate.accessTokenExpiresAt) ||
    !(
      candidate.refreshToken === null ||
      typeof candidate.refreshToken === "string"
    ) ||
    !nullableInstant(candidate.refreshTokenExpiresAt)
  ) {
    throw new Error("Unreadable GitHub OAuth token set");
  }
  return {
    v: 1,
    accessToken: candidate.accessToken,
    accessTokenExpiresAt: candidate.accessTokenExpiresAt,
    refreshToken: candidate.refreshToken,
    refreshTokenExpiresAt: candidate.refreshTokenExpiresAt,
  };
}

export async function refreshGitHubTokenSet(
  tokens: GitHubTokenSet
): Promise<GitHubTokenSet> {
  if (!tokens.refreshToken)
    throw new ProviderError(
      "auth",
      "GitHub connection must be authorized again"
    );
  if (
    tokens.refreshTokenExpiresAt !== null &&
    tokens.refreshTokenExpiresAt <= Date.now()
  ) {
    throw new ProviderError("auth", "GitHub refresh token expired");
  }
  let res: Response;
  try {
    res = await safeFetch({
      site: "https://github.com",
      url: "https://github.com/login/oauth/access_token",
      intent: "read",
      init: {
        method: "POST",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: env.githubClientId,
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
        }).toString(),
      },
      fail: (status, message) =>
        new ProviderError("invalid", message, { status }),
    });
  } catch (e) {
    throw normalizeError(e);
  }
  let answer: GitHubOAuthResponse = {};
  try {
    answer = (await res.json()) as GitHubOAuthResponse;
  } catch {
    if (res.ok)
      throw new ProviderError("invalid", "GitHub OAuth answer is not JSON", {
        status: res.status,
      });
  }
  if (!res.ok) {
    const kind =
      res.status >= 500
        ? "unavailable"
        : answer.error === "bad_refresh_token"
          ? "auth"
          : kindOfStatus(res.status);
    throw new ProviderError(
      kind,
      `GitHub OAuth refresh answered ${res.status}`,
      { status: res.status }
    );
  }
  if (answer.error === "bad_refresh_token")
    throw new ProviderError("auth", "GitHub refresh token refused");
  if (answer.error)
    throw new ProviderError("invalid", "GitHub OAuth refresh refused");
  return gitHubTokenSetFromResponse(answer);
}
