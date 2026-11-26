import { HOST_API, STORE_HOST_API, SLOT_IDS } from "@contracts/modules";
import { type PaymentMethod, type StoreItem } from "@contracts/store";
import { storeCatalogSchema } from "@contracts/storeSchema";
import { env } from "../lib/env";
import { readCapped } from "./body";
import { getServerSetting, setServerSetting } from "../lib/serverSettings";

/**
 * The store Worker, seen from this server. Besides Jira, the only outbound
 * calls inkledger makes, and only when someone opens Settings → Store, asks for a
 * licence or pays, or (once an admin turns sharing on, and per feedback with its
 * author's consent) when feedback is shared with inkledger's developers
 * (feedback/upstream.ts). STORE_URL=off removes them all. The page never talks to the
 * Worker: tokens stay server-side.
 */

const TIMEOUT_MS = 8000;
/**
 * The catalog changes rarely (a new module, a price): kept 12 hours, in
 * memory and in server_settings so restarts don't ask again. Every Store
 * visit would otherwise be a Worker request (the free tier counts them).
 */
export const CATALOG_TTL_MS = 12 * 3_600_000;
const CATALOG_KEY = "store.catalog";

export class StoreError extends Error {
  readonly code: "off" | "unreachable" | "rejected";
  readonly status: number;
  readonly detail: string;
  constructor(code: StoreError["code"], status = 0, detail = "") {
    super(`store ${code}${status ? ` ${status}` : ""}${detail ? `: ${detail}` : ""}`);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** The most an answer of the store may hold (the catalog is a few KB): anything larger is refused unread. */
const MAX_ANSWER_BYTES = 1024 * 1024;

/** The answer's body, read up to the limit (declared or not): over it, refused. */
async function bounded(res: Response): Promise<Uint8Array<ArrayBuffer>> {
  const body = await readCapped(res, MAX_ANSWER_BYTES);
  if (!body) throw new StoreError("rejected", res.status, "too large");
  return body;
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  if (!env.storeUrl) throw new StoreError("off");
  let res: Response;
  try {
    // The store's own address only: a redirect elsewhere (another host, this network) is refused.
    res = await fetch(`${env.storeUrl}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new StoreError("unreachable");
  }
  let body: Uint8Array<ArrayBuffer>;
  try {
    body = await bounded(res);
  } catch (e) {
    if (e instanceof StoreError) throw e;
    throw new StoreError("unreachable");
  }
  if (!res.ok) {
    let error = "";
    try {
      error = (JSON.parse(new TextDecoder().decode(body)) as { error?: string }).error ?? "";
    } catch {
      // not JSON: no detail
    }
    // Not the store's own refusal (its answers say why): a page in front of it (a rate limit, a
    // challenge, a route not there) is no answer, never a "no" that drops a licence.
    throw new StoreError(res.status >= 500 || !error ? "unreachable" : "rejected", res.status, error);
  }
  return new Response(body, { status: res.status, headers: res.headers });
}

const postJson = (path: string, data: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

/** A call to the store with headers of its own (feedback, signed by this server's key: feedback/upstream.ts). */
export const callStore = (path: string, init: RequestInit) => call(path, init);

/** A call to the store (activation, modules/activation.ts): POST with JSON, or GET without a body. */
export const postStore = (path: string, data: unknown, method: "POST" | "GET" = "POST") => (method === "GET" ? call(path) : postJson(path, data));

type Cached = { at: number; raw: unknown };
let cached: Cached | null = null;

const itemsOf = (raw: unknown): StoreItem[] | null => {
  const parsed = storeCatalogSchema.safeParse(raw);
  return parsed.success ? parsed.data.items : null;
};

/** The catalog: fresh copy within the TTL, else the Worker; the last copy if it is unreachable. */
export async function fetchCatalog(now = Date.now()): Promise<StoreItem[]> {
  cached ??= await getServerSetting<Cached | null>(CATALOG_KEY, null);
  const fresh = cached && now - cached.at < CATALOG_TTL_MS ? itemsOf(cached.raw) : null;
  if (fresh) return fresh;
  try {
    const raw: unknown = await (await call("/catalog")).json();
    const items = itemsOf(raw);
    if (!items) throw new StoreError("unreachable", 0, "catalog");
    cached = { at: now, raw };
    await setServerSetting(CATALOG_KEY, cached);
    return items;
  } catch (e) {
    const stale = cached && e instanceof StoreError && e.code !== "off" ? itemsOf(cached.raw) : null;
    if (stale) return stale;
    throw e;
  }
}

/** After the catalog may have changed (a checkout refused by mode), and for tests. */
export async function forgetCatalog() {
  cached = null;
  await setServerSetting(CATALOG_KEY, null);
}

export async function requestLicense(r: { product: string; email: string; message: string; locale: string }) {
  const { token } = (await (await postJson("/request", r)).json()) as { token: string };
  return token;
}

/** A payment page: https, or a store on this machine (a local test store). */
const paymentPage = (u: URL) => u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));

export async function startCheckout(r: { product: string; method: PaymentMethod; email?: string }) {
  const answer = (await (await postJson("/checkout", r)).json()) as { token: string; url: unknown };
  // The page opens it as is (browser or OS opener): a payment page, never javascript: or file:.
  if (typeof answer.url !== "string" || !URL.canParse(answer.url) || !paymentPage(new URL(answer.url))) throw new StoreError("unreachable", 0, "checkout url");
  return { token: answer.token, url: answer.url };
}

export type TokenStatus = { status: "pending" | "approved" | "declined"; license?: string };

/** A licence request's state. A checkout's token never reads a licence: its payer's code does (claimPaid). */
export async function tokenStatus(token: string): Promise<TokenStatus | null> {
  try {
    return (await (await call(`/request/${token}`)).json()) as TokenStatus;
  } catch (e) {
    // The Worker forgot it: nothing will ever come.
    if (e instanceof StoreError && e.status === 404) return null;
    throw e;
  }
}

/** The licence of a paid order, for the code its payer was shown after paying. */
export async function claimPaid(code: string): Promise<{ license: string; product: string }> {
  const answer = (await (await postJson("/claim-paid", { code })).json()) as { license?: unknown; product?: unknown };
  if (typeof answer.license !== "string" || typeof answer.product !== "string") throw new StoreError("unreachable", 0, "claim");
  return { license: answer.license, product: answer.product };
}

/** The signed bundle for whoever holds a licence of the product (reinstall, update). */
export async function bundleForLicense(product: string, license: string, activation?: string): Promise<string> {
  return (await postJson(`/bundle/${product}`, { license, host: HOST, ...(activation ? { activation } : {}) })).text();
}

/** The signed bundle (.iklmod JSON) for a licensed token. */
export async function downloadBundle(product: string, token: string): Promise<string> {
  return (await call(`/download/${product}?token=${encodeURIComponent(token)}&api=${HOST.api}&apiMin=${HOST.apiMin}&apiMax=${HOST.apiMax}&slots=${HOST.slots.join(",")}`)).text();
}

/**
 * What this inkledger runs, sent with every bundle request: the store answers
 * with the newest build that fits, never one that would not load here. The
 * range (apiMin..apiMax) is what the Store reads; `api` is for a Store from
 * before ranges, which reads one version.
 */
const HOST = { api: STORE_HOST_API, apiMin: HOST_API.min, apiMax: HOST_API.max, slots: [...SLOT_IDS] };
