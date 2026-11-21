import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSecureContext } from "node:tls";

const WARN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const RENEW = "run `pnpm https cert` on the Docker host, then `docker restart inkledger`";

/** What TLS_DIR holds: a usable certificate, or why this server stays on plain HTTP. */
export type TlsLoad =
  | { on: true; cert: string; key: string; warning: string | null }
  | { on: false; reason: string };

function errorCode(e: unknown): unknown {
  return e instanceof Error && "code" in e ? e.code : undefined;
}

/** A certificate that ended, or will soon: a browser refuses the first and nothing warns of the second. */
function expiryWarning(validTo: Date, now: Date): string | null {
  const days = Math.ceil((validTo.getTime() - now.getTime()) / DAY_MS);
  if (days <= 0) return `the HTTPS certificate expired on ${validTo.toISOString().slice(0, 10)}: ${RENEW}`;
  if (days <= WARN_DAYS) return `the HTTPS certificate expires in ${days} days: ${RENEW}`;
  return null;
}

/**
 * Reads server.crt and server.key from `dir`. Never throws: HTTPS is an extra,
 * a bad certificate must not take the plain HTTP server down with it.
 */
export function loadTls(dir: string, now: Date = new Date()): TlsLoad {
  const read = (name: string) => readFileSync(path.join(dir, name), "utf8");
  let cert: string;
  let key: string;
  try {
    cert = read("server.crt");
    key = read("server.key");
  } catch (e) {
    return {
      on: false,
      reason:
        errorCode(e) === "ENOENT"
          ? `no certificate in ${dir}: ${RENEW}`
          : `cannot read the certificate in ${dir} (${String(errorCode(e))}): the key must be readable by the server's user`,
    };
  }
  try {
    createSecureContext({ cert, key });
    const validTo = new Date(new X509Certificate(cert).validTo);
    return { on: true, cert, key, warning: expiryWarning(validTo, now) };
  } catch (e) {
    return { on: false, reason: `the certificate in ${dir} is not usable (${e instanceof Error ? e.message : String(e)}): ${RENEW}` };
  }
}
