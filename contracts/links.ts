
/**
 * External links: which hosts open freely. A domain allows itself and its
 * subdomains ("google.com" → drive.google.com); "*.x.it" is the same as
 * "x.it". The Jira site is always allowed.
 */
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "https://Drive.Google.com/x" / "*.google.com" → "drive.google.com" / "google.com"; null if not a domain. */
export function normalizeDomain(input: string): string | null {
  let v = input.trim().toLowerCase();
  if (!v) return null;
  if (v.includes("://")) {
    try {
      v = new URL(v).hostname;
    } catch {
      return null;
    }
  }
  v = v.replace(/^\*\./, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  return HOST_RE.test(v) ? v : null;
}

export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some(d => h === d || h.endsWith(`.${d}`));
}

/** Only these open from Jira text; anything else (javascript:, data:) stays text. */
export function safeExternalUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url : null;
  } catch {
    return null;
  }
}
