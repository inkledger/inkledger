// HTTP to a tracker, for every provider: redirects followed by hand and
// re-checked (an automatic follow would let a site, or anyone answering in
// its place, bounce the server with credentials to internal addresses), and
// the read-only switch for test servers on a copied database.
import { lookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent } from "undici";
import { env } from "../../lib/env";
import { assertSafeUrl, isForbiddenAddress, isReservedHost, type Network } from "../../lib/security";
import { t } from "@contracts/i18n";
import { callSignal, currentCall } from "./context";

/** Whether a call only reads (allowed on a read-only server) or may change something. */
export type Intent = "read" | "write";

/** GET and HEAD read; anything else writes unless the call says it only reads (a POST carrying a list of ids). */
export const intentOf = (method: string | undefined, declared?: Intent): Intent =>
  declared ?? (["GET", "HEAD"].includes((method ?? "GET").toUpperCase()) ? "read" : "write");

/** Redirects followed by hand (redirect: "manual"), each one re-validated. */
const MAX_REDIRECTS = 3;

/**
 * Connections made only to addresses the network allows, checked when the
 * socket opens: a name that resolved to a public address for the check and
 * to an internal one for the call (DNS rebinding) never connects.
 */
function guardedAgent(network: Network): Agent {
  return new Agent({
    connect: {
      lookup: (host, options, done) => {
        lookup(host, { ...options, all: true }, (err, found: LookupAddress[]) => {
          if (err) return done(err, "", 0);
          const bad = found.find((a) => isForbiddenAddress(a.address, network));
          if (bad || found.length === 0) return done(Object.assign(new Error(`${host}: address not allowed`), { code: "EADDRNOTALLOWED" }), "", 0);
          if ((options as { all?: boolean }).all) return (done as unknown as (e: null, a: LookupAddress[]) => void)(null, found);
          done(null, found[0].address, found[0].family);
        });
      },
    },
  });
}
const agents: Record<Network, Agent> = { public: guardedAgent("public"), private: guardedAgent("private") };

export type SafeFetch = {
  /** The tracker's site: same-origin redirects keep the Authorization header. */
  site: string;
  url: string;
  init: RequestInit;
  intent?: Intent;
  /** Follow a redirect to another https origin (without Authorization), e.g. an attachment CDN. */
  allowCrossOrigin?: boolean;
  /** The provider's error for a refused call (read-only, redirect not allowed). */
  fail: (status: number, message: string) => Error;
  /** "private" only for a self-hosted tracker; a service on the internet never reaches private addresses. */
  network?: Network;
};

export async function safeFetch({ site, url, init, intent, allowCrossOrigin = false, fail, network = "public" }: SafeFetch): Promise<Response> {
  const verb = (init.method ?? "GET").toUpperCase();
  // The server read-only (test servers), or this connection's adapter not verified and its writes not allowed yet.
  if ((env.readOnly || currentCall()?.readOnly) && intentOf(verb, intent) === "write") {
    // Marked, so the binding reports it as "readOnly" whatever error type the provider uses.
    throw Object.assign(fail(403, t("server.jira.readOnly", { verb })), { providerKind: "readOnly" as const });
  }
  const origin = new URL(site).origin;
  let target = url;
  // The call's cancellation and correlation id reach every request.
  const signal = callSignal(init.signal);
  const correlation = currentCall()?.correlationId;
  // Headers as given unless a correlation id is added (callers may inspect them).
  const headers = correlation ? new Headers(init.headers) : init.headers;
  if (correlation && headers instanceof Headers) headers.set("X-Request-Id", correlation);
  // Never the server's own neighbours. A name's address is checked by the agent when it connects; an address written out, here.
  const first = new URL(target).hostname.replace(/^\[|\]$/g, "");
  if (isReservedHost(first) || (isIP(first) !== 0 && isForbiddenAddress(first, network))) throw fail(400, t("server.url.hostNotAllowed", { host: first }));
  let req: RequestInit = { ...init, headers, redirect: "manual", ...(signal ? { signal } : {}), ...({ dispatcher: agents[network] } as object) };
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(target, req);
    } catch (e) {
      // Refused by the agent: a forbidden address, not a network outage (nothing to queue).
      if ((e as { cause?: { code?: string } }).cause?.code === "EADDRNOTALLOWED") throw fail(400, t("server.url.hostNotAllowed", { host: new URL(target).hostname }));
      throw e;
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw fail(502, t("server.jira.redirectNotAllowed"));
    const next = new URL(location, target);
    const sameOrigin = next.origin === origin;
    if (!sameOrigin && !(allowCrossOrigin && next.protocol === "https:")) {
      throw fail(502, t("server.jira.redirectNotAllowed"));
    }
    try {
      await assertSafeUrl(next.toString(), { network: sameOrigin ? network : "public" });
    } catch {
      throw fail(502, t("server.jira.redirectNotAllowed"));
    }
    // 303 (and 301/302 after a non-GET, as browsers do) continue as GET without body.
    const method = (req.method ?? "GET").toUpperCase();
    const toGet =
      res.status === 303 ||
      ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD");
    const hopHeaders = new Headers(req.headers);
    if (!sameOrigin) hopHeaders.delete("Authorization");
    if (toGet) hopHeaders.delete("Content-Type");
    req = { ...req, headers: hopHeaders, ...(toGet ? { method: "GET", body: undefined } : {}) };
    target = next.toString();
  }
}
