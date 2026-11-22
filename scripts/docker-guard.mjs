// The env file guard of docker-update.mjs, apart so it can be tested without docker.

/** The DATABASE_URL in an env file's text that names the old jtt stack's database or host, else null. */
export function jttDatabaseUrl(envText) {
  for (const line of envText.split("\n")) {
    const url = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*["']?([^"'\s]+)/.exec(line)?.[1];
    // Its host (with or without a port), its database, or its Postgres through the host port.
    if (url && /@jtt[\w-]*(?:[:/?]|$)|\/jtt(?:[?]|$)|:54329(?:[/?]|$)/.test(url)) return url;
  }
  return null;
}
