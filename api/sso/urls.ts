// The addresses this server answers single sign-on at: always under PUBLIC_URL, never
// taken from the request's Host header (a forged one would send the provider elsewhere).
import { env } from "../lib/env";

export type SpUrls = { redirectUri: string; acs: string; entityId: string; metadata: string };

/** The provider's addresses here, or null while PUBLIC_URL is unset. */
export function spUrls(providerId: number, base: string | null = env.publicUrl): SpUrls | null {
  if (!base) return null;
  const root = base.replace(/\/+$/, "");
  const at = `${root}/api/sso/${providerId}`;
  return { redirectUri: `${at}/callback`, acs: `${at}/acs`, entityId: `${at}/metadata`, metadata: `${at}/metadata` };
}

/** A control character or a backslash: never in a path to go back to. */
const unsafeChar = (s: string) => [...s].some((c) => c.charCodeAt(0) < 32 || c === "\\");

/** Where to go after signing in: a path of this app, never another site ("//x", "/\\x", a scheme). */
export function safeRelay(raw: string | null | undefined): string {
  if (!raw || raw.length > 512) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || unsafeChar(raw)) return "/";
  if (raw.startsWith("/login") || raw.startsWith("/api/")) return "/";
  return raw;
}
