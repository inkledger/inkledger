/**
 * Canonical Jira base URL: lowercase host, no default port, no query/hash,
 * no trailing slashes. The same site always maps to the same user row and
 * rate-limit key, however it was typed. Dependency-free (no env/db): shared
 * by auth and the database migrations.
 */
export function normalizeSiteUrl(raw: string): string {
  const u = new URL(raw);
  // URL already lowercases the host and drops the scheme's default port.
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host.toLowerCase()}${path}`;
}
