// Licences activated per server (WP-19). A licence (v1, unchanged) unlocks a
// product only on a server the store activated it for: the store hands this
// server a token naming its instance (instance.ts), signed with the store's
// activation key, valid 90 days and renewed before it ends. At most a few
// servers per licence at a time (the store counts them).
//
// Not needed: in development and tests (not production), or when a trusted
// extra key is set (MODULES_TRUST_EXTRA_KEY), so test modules and the dev
// server never take a slot. Without the activation key in this build (keys.ts
// ACTIVATION_KEYS empty) nothing can be checked: activation is not asked and
// the server says so at start.
import { verifyEnvelope } from "../vendor/seal/envelope";
import { env } from "../lib/env";
import { getServerSetting, setServerSetting } from "../lib/serverSettings";
import { StoreError, postStore } from "../store/client";
import { ACTIVATION_KEYS, asPem, extraKey } from "./keys";
import { instance, proofMessage } from "./instance";

export const ACTIVATION_CONTEXT = "inkledger-activation-v1\n";
const TOKENS_KEY = "modules.activations";
const GRACE_KEY = "modules.grace";
const DAY = 86_400_000;
/** Renewed when less than this is left. */
export const RENEW_BEFORE_MS = 30 * DAY;
/** The store unreachable when renewing (network, 5xx): a token keeps working this long past its end. */
export const GRACE_MS = 30 * DAY;
/** Clocks differ: a token is still good a day past its end. */
const SKEW_MS = DAY;

export type ActivationPayload = { lic: string; product: string; inst: string; iat: number; exp: number; v: 1 };

/** The activation keys trusted: the build's; under Vitest, a test's own (TEST_ACTIVATION_KEY) too. */
const activationKeys = (): string[] => [...ACTIVATION_KEYS, ...(process.env.VITEST && process.env.TEST_ACTIVATION_KEY ? [process.env.TEST_ACTIVATION_KEY] : [])];

/** Whether this server must hold an activation for its licences (under Vitest: when a test asks, TEST_ACTIVATION_REQUIRED). */
export const activationRequired = () =>
  (env.isProduction || (!!process.env.VITEST && process.env.TEST_ACTIVATION_REQUIRED === "1")) && !extraKey() && activationKeys().length > 0;

/** A token from the store, checked: its signature, version and shape (not yet whose it is). */
export function readActivation(token: string): ActivationPayload | null {
  const v = verifyEnvelope(token, { context: ACTIVATION_CONTEXT, keys: activationKeys().map(asPem) });
  if (!v.ok) return null;
  try {
    const p = JSON.parse(v.payload.toString("utf8")) as Partial<ActivationPayload>;
    return typeof p.lic === "string" && typeof p.product === "string" && typeof p.inst === "string" && typeof p.iat === "number" && typeof p.exp === "number" && p.v === 1
      ? (p as ActivationPayload)
      : null;
  } catch {
    return null;
  }
}

/** Tokens of this server's instance, by licence id. */
type Tokens = Record<string, Record<string, string>>;
const tokens = async () => getServerSetting<Tokens>(TOKENS_KEY, {});
/** Licence id → until when the store being unreachable is forgiven. */
const graces = async () => getServerSetting<Record<string, number>>(GRACE_KEY, {});

async function saveToken(licenseId: string, token: string | null) {
  const all = await tokens();
  const mine = { ...(all[instance().id] ?? {}) };
  if (token) mine[licenseId] = token;
  else delete mine[licenseId];
  await setServerSetting(TOKENS_KEY, { ...all, [instance().id]: mine });
}

async function setGrace(licenseId: string, until: number | null) {
  const g = { ...(await graces()) };
  if (until === null) delete g[licenseId];
  else g[licenseId] = until;
  await setServerSetting(GRACE_KEY, g);
}

export type ActivationState =
  | { state: "active"; exp: number }
  | { state: "grace"; until: number }
  | { state: "missing" }
  | { state: "not-required" };

let memo: { at: number; value: Map<string, ActivationState> } | null = null;
/** Checks are cached a minute (every module file asks). */
const MEMO_MS = 60_000;
export const forgetActivations = () => {
  memo = null;
};

/** Each stored licence's activation here, by licence id. */
export async function activationStates(licenses: { id: string; product: string }[], now = Date.now()): Promise<Map<string, ActivationState>> {
  if (!activationRequired()) return new Map(licenses.map((l) => [l.id, { state: "not-required" }]));
  if (memo && now - memo.at < MEMO_MS && licenses.every((l) => memo!.value.has(l.id))) return memo.value;
  const mine = (await tokens())[instance().id] ?? {};
  const grace = await graces();
  const value = new Map<string, ActivationState>();
  for (const l of licenses) {
    const p = mine[l.id] ? readActivation(mine[l.id]) : null;
    const good = p && p.inst === instance().id && p.lic === l.id && p.product === l.product;
    if (good && now <= p.exp + SKEW_MS) value.set(l.id, { state: "active", exp: p.exp });
    else if ((grace[l.id] ?? 0) > now) value.set(l.id, { state: "grace", until: grace[l.id] });
    else value.set(l.id, { state: "missing" });
  }
  memo = { at: now, value };
  return value;
}

export type ActivateResult = { ok: true; exp: number; active: number; limit: number } | { ok: false; reason: "limit" | "revoked" | "license" | "unreachable" | "off" | "rate" | "invalid" };

/** Asks the store to activate (or renew) a licence on this server; the token is kept. */
export async function activate(license: string, licenseId: string, now = Date.now()): Promise<ActivateResult> {
  const me = instance();
  try {
    const { nonce } = (await (await postStore("/nonce", undefined, "GET")).json()) as { nonce: string };
    const r = (await (
      await postStore("/activate", { license, instanceId: me.id, pubkey: me.pubkey, nonce, sig: me.sign(proofMessage("activate", nonce, me.id, licenseId)) })
    ).json()) as { token: string; exp: number; active: number; limit: number };
    if (!readActivation(r.token)) return { ok: false, reason: "invalid" };
    await saveToken(licenseId, r.token);
    await setGrace(licenseId, null);
    forgetActivations();
    return { ok: true, exp: r.exp, active: r.active, limit: r.limit };
  } catch (e) {
    if (!(e instanceof StoreError)) throw e;
    if (e.code === "off") return { ok: false, reason: "off" };
    if (e.code === "unreachable") {
      // Not the licence's fault: what it had keeps working a while longer.
      const had = (await activationStates([{ id: licenseId, product: "" }], now)).get(licenseId);
      const current = (await tokens())[me.id]?.[licenseId];
      const p = current ? readActivation(current) : null;
      if (!had || had.state !== "grace") await setGrace(licenseId, Math.max(p ? p.exp + GRACE_MS : 0, now + GRACE_MS));
      forgetActivations();
      return { ok: false, reason: "unreachable" };
    }
    // Refused: the server stops at once (revoked, released elsewhere, over the limit).
    const reason = e.detail === "limit" || e.detail === "revoked" || e.detail === "license" || e.detail === "rate" ? e.detail : "invalid";
    if (reason !== "rate") {
      await saveToken(licenseId, null);
      await setGrace(licenseId, null);
    }
    forgetActivations();
    return { ok: false, reason };
  }
}

/** Frees this server's slot for a licence (the store counts one less). */
export async function deactivate(license: string, licenseId: string): Promise<void> {
  const me = instance();
  const { nonce } = (await (await postStore("/nonce", undefined, "GET")).json()) as { nonce: string };
  await postStore("/deactivate", { license, instanceId: me.id, pubkey: me.pubkey, nonce, sig: me.sign(proofMessage("deactivate", nonce, me.id, licenseId)) });
  await saveToken(licenseId, null);
  forgetActivations();
}

/** The servers a licence is active on (ids only), and how many it may be. */
export async function activationsOf(license: string): Promise<{ limit: number; active: { instanceId: string; iat: number; exp: number }[]; here: string }> {
  const r = (await (await postStore("/activations", { license })).json()) as { limit: number; active: { instanceId: string; iat: number; exp: number }[] };
  return { ...r, here: instance().id };
}

/**
 * Activation without reaching the store from here (STORE_URL=off, D15): the
 * code this server shows, signed with a dated offline nonce, is pasted on the
 * store's page from another device; the token it gives is pasted back.
 */
export function offlineCode(licenseId: string, now = Date.now()): string {
  const me = instance();
  const nonce = `offline:${now}`;
  return Buffer.from(JSON.stringify({ instanceId: me.id, pubkey: me.pubkey, nonce, sig: me.sign(proofMessage("activate", nonce, me.id, licenseId)) })).toString("base64url");
}

/** A token pasted back from the store's offline page: kept when it is this server's, for this licence. */
export async function acceptToken(token: string, licenseId: string, product: string): Promise<boolean> {
  const p = readActivation(token.trim());
  if (!p || p.inst !== instance().id || p.lic !== licenseId || p.product !== product) return false;
  await saveToken(licenseId, token.trim());
  await setGrace(licenseId, null);
  forgetActivations();
  return true;
}

/**
 * The renewal pass (scheduler, every 12 hours; at start): each licence with
 * no token, or one ending within RENEW_BEFORE_MS, asks the store again.
 */
export async function renewActivations(licenses: { id: string; product: string; text: string }[], now = Date.now()) {
  if (!activationRequired() || !env.storeUrl) return [];
  const mine = (await tokens())[instance().id] ?? {};
  const out: { id: string; result: ActivateResult }[] = [];
  for (const l of licenses) {
    const p = mine[l.id] ? readActivation(mine[l.id]) : null;
    if (p && p.inst === instance().id && p.exp - now > RENEW_BEFORE_MS) continue;
    out.push({ id: l.id, result: await activate(l.text, l.id, now) });
  }
  return out;
}

export const ACTIVATION_DEFAULTS = { renewEveryMs: 12 * 3_600_000 };

/** This server's token for a licence, if it holds one. */
export async function tokenFor(licenseId: string): Promise<string | undefined> {
  return (await tokens())[instance().id]?.[licenseId];
}

/** A licence just added (store, file): activated here at once when this server needs it. */
export async function activateNew(license: string, licenseId: string): Promise<ActivateResult | null> {
  return activationRequired() ? activate(license, licenseId) : null;
}
