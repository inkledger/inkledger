/**
 * Trusted Ed25519 public keys (PEM SPKI). Empty means nothing verifies (fail
 * closed). Packages and licences have separate lists: a licence key lives on
 * online services (the store Worker, the licence-request Action), so a leak
 * there must never let anyone sign code this server runs.
 */

/** The publisher key (offline, ~/.config/seal): signs packages and hand-made licences. */
const PUBLISHER_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA1etNGb4TL2Eeu60uWvKF9YvAvz3s0dXPL/rAhXx7OQQ=
-----END PUBLIC KEY-----`;

/** Keys whose packages load here. */
export const PACKAGE_KEYS: readonly string[] = [PUBLISHER_KEY];

/** Who issues licences, by key: the name tells the user where a licence came from. */
export const LICENSE_ISSUERS = {
  // Hand-made beta licences.
  publisher: PUBLISHER_KEY,
  // Store Worker (paid orders).
  store: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMc/6TUxBGEtXwPo0Bv99lIeWTIRSjAGIjM/5slACI8g=
-----END PUBLIC KEY-----`,
  // Licence-request Action (free releases approved by hand).
  inbox: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZYHt7yKtYAV5zl3nWxmoyR9LWCXFkjVbCA1GoVGCj/E=
-----END PUBLIC KEY-----`,
} as const;
export type LicenseIssuer = keyof typeof LICENSE_ISSUERS | "dev";

/** Keys whose licences unlock products here; several entries let a key rotate. */
export const LICENSE_KEYS: readonly string[] = Object.values(LICENSE_ISSUERS);

/**
 * The store's activation key (WP-18/19): it signs "this licence is active on
 * this server" tokens, nothing else. Its own key, so a leak never lets anyone
 * sign licences or code. With none, activation is not asked (tests set their own).
 */
export const ACTIVATION_KEYS: readonly string[] = ["MCowBQYDK2VwAyEAi9XsQo0FORVOMiEPOR1kpbhlo5Xmwwf+UCsqJ2MfgLQ="];

/** A bare base64 SPKI (the PEM body alone) is wrapped back into PEM. */
export function asPem(key: string): string {
  const k = key.trim();
  return k.startsWith("-----") ? k : `-----BEGIN PUBLIC KEY-----\n${k}\n-----END PUBLIC KEY-----\n`;
}

/**
 * One more trusted key from MODULES_TRUST_EXTRA_KEY, for development and the
 * e2e tests only ("\n" may be written as \\n), trusted for packages and
 * licences. It lets anyone holding the matching private key ship modules here,
 * so the server logs it at boot and Settings → Extras shows a banner.
 */
export function extraKey(): string | null {
  const raw = process.env.MODULES_TRUST_EXTRA_KEY?.trim();
  if (!raw) return null;
  // A production server takes it only when told twice (MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION=1:
  // the e2e tests and the studio run the production bundle with it); a stray env var never does.
  if (process.env.NODE_ENV === "production" && process.env.MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION !== "1") return null;
  return asPem(raw.replace(/\\n/g, "\n"));
}

const withExtra = (keys: readonly string[]): string[] => {
  const extra = extraKey();
  const pems = keys.map(asPem);
  return extra ? [...pems, extra] : pems;
};

export const packageKeys = (): string[] => withExtra(PACKAGE_KEYS);
export const licenseKeys = (): string[] => withExtra(LICENSE_KEYS);
