import { storeCatalogSchema, type PaymentMethod, type StoreItem } from "@contracts/store";
import { env } from "../lib/env";
import { getServerSetting, setServerSetting } from "../lib/serverSettings";

/**
 * The store Worker, seen from this server. Besides Jira, the only outbound
 * calls inkledger makes, and only when someone opens Settings → Store, asks for a
 * licence or pays (STORE_URL=off removes them). The page never talks to the
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

async function call(path: string, init?: RequestInit): Promise<Response> {
  if (!env.storeUrl) throw new StoreError("off");
  let res: Response;
  try {
    res = await fetch(`${env.storeUrl}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new StoreError("unreachable");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new StoreError(res.status >= 500 ? "unreachable" : "rejected", res.status, body.error ?? "");
  }
  return res;
}

const postJson = (path: string, data: unknown) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

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

export async function startCheckout(r: { product: string; method: PaymentMethod; email?: string }) {
  return (await (await postJson("/checkout", r)).json()) as { token: string; url: string };
}

export type TokenStatus = { status: "pending" | "approved" | "declined" | "paid"; license?: string };

export async function tokenStatus(kind: "request" | "paid", token: string): Promise<TokenStatus | null> {
  try {
    return (await (await call(kind === "request" ? `/request/${token}` : `/claim/${token}`)).json()) as TokenStatus;
  } catch (e) {
    // The Worker forgot it (expired checkout): nothing will ever come.
    if (e instanceof StoreError && e.status === 404) return null;
    throw e;
  }
}

/** The signed bundle for whoever holds a licence of the product (reinstall, update). */
export async function bundleForLicense(product: string, license: string, activation?: string): Promise<string> {
  return (await postJson(`/bundle/${product}`, { license, ...(activation ? { activation } : {}) })).text();
}

/** The signed bundle (.iklmod JSON) for a licensed token. */
export async function downloadBundle(product: string, token: string): Promise<string> {
  return (await call(`/download/${product}?token=${encodeURIComponent(token)}`)).text();
}
