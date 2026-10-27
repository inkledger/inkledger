// Signing in to GitHub from the app (OAuth device flow): inkledger asks GitHub for
// a code, the user enters it on github.com and authorizes, inkledger waits for the
// token. No password and no redirect reach inkledger, which suits a server on a
// private address. Pending logins live in this process, a quarter of an hour.
import { randomUUID } from "node:crypto";
import { env } from "../../lib/env";
import { kindOfStatus, ProviderError } from "../core/errors";
import { safeFetch } from "../core/http";
import {
  gitHubTokenSetFromResponse,
  type GitHubOAuthResponse,
  type GitHubTokenSet,
} from "./oauth";

const WEB = "https://github.com";
/** What inkledger asks for: the user's repositories' issues, their projects, their notifications. */
export const GITHUB_SCOPES =
  "repo read:project project notifications offline_access";

type Flow = {
  userId: number;
  deviceCode: string;
  intervalMs: number;
  nextAt: number;
  expiresAt: number;
  label: string;
};
const flows = new Map<string, Flow>();

async function post<T>(path: string, form: Record<string, string>): Promise<T> {
  const res = await safeFetch({
    site: WEB,
    url: `${WEB}${path}`,
    // Signing in changes nothing on GitHub: allowed on a read-only server too.
    intent: "read",
    init: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form).toString(),
    },
    fail: (status, message) =>
      new ProviderError("invalid", message, { status }),
  });
  if (!res.ok) {
    // What GitHub's answer means (busy, not allowed, down); a 401 here is this app's, no connection to reconnect.
    const kind = kindOfStatus(res.status);
    throw new ProviderError(
      kind === "auth" ? "invalid" : kind,
      `GitHub answered ${res.status}`,
      { status: res.status }
    );
  }
  return (await res.json()) as T;
}

/** A new login: the code to enter on GitHub, and where. */
export async function startDeviceLogin(userId: number, label: string) {
  const r = await post<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  }>("/login/device/code", {
    client_id: env.githubClientId,
    scope: GITHUB_SCOPES,
  });
  const id = randomUUID();
  const now = Date.now();
  flows.set(id, {
    userId,
    deviceCode: r.device_code,
    intervalMs: Math.max(5, r.interval) * 1000,
    nextAt: now,
    expiresAt: now + r.expires_in * 1000,
    label,
  });
  for (const [k, f] of flows) if (f.expiresAt < now) flows.delete(k);
  return {
    flowId: id,
    userCode: r.user_code,
    verificationUri: r.verification_uri,
    intervalSeconds: Math.max(5, r.interval),
    expiresIn: r.expires_in,
  };
}

export type PollResult =
  | { state: "pending"; retryInSeconds: number }
  | { state: "failed"; reason: "denied" | "expired" }
  | { state: "authorized"; tokens: GitHubTokenSet; label: string };

/** Asks GitHub once whether the user authorized (never faster than GitHub's interval). */
export async function pollDeviceLogin(
  userId: number,
  flowId: string
): Promise<PollResult> {
  const f = flows.get(flowId);
  if (!f || f.userId !== userId || f.expiresAt < Date.now()) {
    flows.delete(flowId);
    return { state: "failed", reason: "expired" };
  }
  if (Date.now() < f.nextAt)
    return {
      state: "pending",
      retryInSeconds: Math.ceil((f.nextAt - Date.now()) / 1000),
    };
  const r = await post<GitHubOAuthResponse & { interval?: number }>(
    "/login/oauth/access_token",
    {
      client_id: env.githubClientId,
      device_code: f.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }
  );
  if (r.access_token) {
    flows.delete(flowId);
    return {
      state: "authorized",
      tokens: gitHubTokenSetFromResponse(r),
      label: f.label,
    };
  }
  if (r.error === "slow_down")
    f.intervalMs = (r.interval ?? f.intervalMs / 1000 + 5) * 1000;
  if (r.error === "authorization_pending" || r.error === "slow_down") {
    f.nextAt = Date.now() + f.intervalMs;
    return { state: "pending", retryInSeconds: Math.ceil(f.intervalMs / 1000) };
  }
  flows.delete(flowId);
  return {
    state: "failed",
    reason: r.error === "access_denied" ? "denied" : "expired",
  };
}
