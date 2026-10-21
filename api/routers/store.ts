import { activateNew, tokenFor } from "../modules/activation";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { runsHere } from "@contracts/modules";
import { LICENSE_FILE_FORMAT, mediaUrl, pickBuild, type StoreCatalog, type StoreEntry, type StorePending } from "@contracts/store";
import { t, type MessageKey } from "@contracts/i18n";
import { createRouter, permProcedure } from "../middleware";
import { env } from "../lib/env";
import { getServerSetting, setServerSetting } from "../lib/serverSettings";
import {
  addLicense,
  installBundle,
  licenseStates,
  listModules,
  older,
  validLicenses,
} from "../modules/registry";
import {
  StoreError,
  bundleForLicense,
  downloadBundle,
  fetchCatalog,
  forgetCatalog,
  requestLicense,
  startCheckout,
  tokenStatus,
} from "../store/client";

/** Server-wide: for whoever may manage the Store and licences. */
const store = permProcedure("manageStore");

/**
 * Settings → Store. Requests and checkouts are kept in server_settings with
 * their Worker token (never sent to the page); `pending` polls the Worker and,
 * once a licence is there, stores it and installs the module like an upload.
 */

const PENDING_KEY = "store.pending";
const PAID_MAX_AGE_MS = 30 * 86_400_000;

type Stored = StorePending & { token: string; created: number };

const readPending = () => getServerSetting<Stored[]>(PENDING_KEY, []);
const savePending = (list: Stored[]) => setServerSetting(PENDING_KEY, list);
const publicPending = ({ product, kind, status, reason }: Stored): StorePending =>
  reason ? { product, kind, status, reason } : { product, kind, status };

const ERRORS: Record<string, MessageKey> = {
  email: "server.store.email",
  rate: "server.store.rate",
  product: "server.store.product",
  method: "server.store.method",
};

function storeFailure(e: unknown): never {
  if (e instanceof StoreError) {
    if (e.code === "off") throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.store.off") });
    if (e.code === "rejected") {
      throw new TRPCError({ code: "BAD_REQUEST", message: t(ERRORS[e.detail] ?? "server.store.rejected") });
    }
    throw new TRPCError({ code: "BAD_GATEWAY", message: t("server.store.unreachable") });
  }
  throw e;
}

const product = z.string().regex(/^inkledger\.[a-z0-9-]+$/);

/**
 * Whether a build replaces what is installed: a newer version, or the same
 * version rebuilt (modules stay 1.0.0 in beta, a fix still has to arrive).
 */
const isUpdate = (installed: { version: string; build: string | null }, b: { version: string; build: string }) =>
  older(installed.version, b.version) || (installed.version === b.version && !!b.build && !!installed.build && b.build !== installed.build);

type Settled = { next: Stored | null; installed: boolean };

/** One pending entry against the Worker: installed (gone), kept, updated or dropped. */
async function settle(p: Stored): Promise<Settled> {
  const keep = (next: Stored | null): Settled => ({ next, installed: false });
  if (p.status !== "pending") return keep(p);
  const s = await tokenStatus(p.kind, p.token);
  // The Worker forgot it: an abandoned checkout goes, a request says so.
  if (!s) return keep(p.kind === "paid" ? null : { ...p, status: "failed", reason: "expired" });
  if (s.status === "declined") return keep({ ...p, status: "declined" });
  if (!s.license) return keep(p.kind === "paid" && Date.now() - p.created > PAID_MAX_AGE_MS ? null : p);
  const l = await addLicense(s.license);
  if (!l.ok) return keep({ ...p, status: "failed", reason: l.reason });
  // Bought or approved: this server takes its slot now (over the limit, the licence waits: Settings says so).
  await activateNew(s.license, l.payload.id);
  const installed = installBundle(await downloadBundle(p.product, p.token));
  // An older version than the installed one is fine: the licence is what was missing.
  if (!installed.ok && installed.reason !== "older-version") return keep({ ...p, status: "failed", reason: installed.reason });
  return { next: null, installed: true };
}

export const storeRouter = createRouter({
  catalog: store.query(async (): Promise<StoreCatalog> => {
    if (!env.storeUrl) return { enabled: false, entries: [] };
    const items = await fetchCatalog().catch(storeFailure);
    const [modules, { licensed: products }, pending] = await Promise.all([listModules(), licenseStates(), readPending()]);
    const entries = items.map((item): StoreEntry => {
      const installed = modules.find((m) => m.product === item.product);
      const p = pending.find((x) => x.product === item.product);
      const { build, newerElsewhere } = pickBuild(item, runsHere, older);
      return {
        ...item,
        version: build?.version ?? item.version,
        image: item.image ? mediaUrl(item.id, "image") : undefined,
        hero: item.hero ? mediaUrl(item.id, "hero") : undefined,
        gallery: item.gallery?.map((g, i) => ({ src: mediaUrl(item.id, `${i}`), caption: g.caption })),
        installed: installed?.status ?? null,
        installedVersion: installed?.version ?? null,
        outdated: !!installed && !!build && isUpdate(installed, build),
        licensed: products.has(item.product),
        supported: build !== null,
        needsNewerHost: newerElsewhere,
        pending: p ? publicPending(p) : null,
      };
    });
    return { enabled: true, entries };
  }),

  requestLicense: store
    .input(
      z.object({
        product,
        email: z.email().max(254),
        message: z.string().max(2000).default(""),
        locale: z.enum(["en", "it"]).default("en"),
      }),
    )
    .mutation(async ({ input }) => {
      const token = await requestLicense(input).catch(storeFailure);
      const others = (await readPending()).filter((p) => p.product !== input.product);
      await savePending([...others, { token, product: input.product, kind: "request", status: "pending", created: Date.now() }]);
      return { ok: true as const };
    }),

  checkout: store
    .input(z.object({ product, method: z.enum(["card", "bitcoin"]), email: z.email().max(254).optional() }))
    .mutation(async ({ input }) => {
      const { token, url } = await startCheckout(input).catch(async (e: unknown) => {
        await forgetCatalog();
        return storeFailure(e);
      });
      const others = (await readPending()).filter((p) => p.product !== input.product);
      await savePending([...others, { token, product: input.product, kind: "paid", status: "pending", created: Date.now() }]);
      return { url };
    }),

  /** Polled by the page while something is pending; installs what has arrived. */
  pending: store.query(async () => {
    const before = await readPending();
    if (before.length === 0) return { pending: [], installed: [] as string[] };
    const after: Stored[] = [];
    const installed: string[] = [];
    for (const p of before) {
      // Unreachable or a failed download: try again next time.
      const r = await settle(p).catch((): Settled => ({ next: p, installed: false }));
      if (r.next) after.push(r.next);
      if (r.installed) installed.push(p.product);
    }
    // Only what this poll changed; a request saved meanwhile is kept.
    const current = await readPending();
    const merged = current.flatMap((c) => {
      const was = before.find((b) => b.token === c.token);
      if (!was) return [c];
      const now = after.find((a) => a.token === c.token);
      return now ? [now] : [];
    });
    await savePending(merged);
    return { pending: merged.map(publicPending), installed };
  }),

  /** Installs or updates a module this server already holds a licence for. */
  install: store.input(z.object({ product })).mutation(async ({ input }) => {
    const license = (await validLicenses()).find((l) => l.product === input.product);
    if (!license) throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.store.noLicense") });
    // The store serves modules to an activated server only (WP-18).
    const bundle = await bundleForLicense(input.product, license.text, await tokenFor(license.id)).catch(storeFailure);
    const r = installBundle(bundle);
    if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.store.installFailed", { reason: r.reason }) });
    return { id: r.id, version: r.version };
  }),

  /**
   * A licence the store issued before, from its file (or the bare text):
   * restores a purchase on another server. Only signed licences pass.
   */
  restoreLicense: store.input(z.object({ text: z.string().trim().min(1).max(8000) })).mutation(async ({ input }) => {
    let text = input.text;
    try {
      const file = JSON.parse(text) as { format?: unknown; license?: unknown };
      if (file.format === LICENSE_FILE_FORMAT && typeof file.license === "string") text = file.license;
    } catch {
      // Not JSON: the bare licence text.
    }
    const l = await addLicense(text.trim());
    if (!l.ok) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.store.badLicence") });
    // Activated here at once; over the limit is said plainly (the licence stays, to activate after freeing a server).
    const a = await activateNew(text.trim(), l.payload.id);
    if (a && !a.ok && a.reason === "limit") throw new TRPCError({ code: "PRECONDITION_FAILED", message: t("server.store.activationLimit") });
    return { product: l.payload.product, activation: a ? (a.ok ? "active" : a.reason) : "not-required" };
  }),

  /** Forgets a declined or failed entry (the page's "OK"), or cancels waiting. */
  dismiss: store.input(z.object({ product })).mutation(async ({ input }) => {
    await savePending((await readPending()).filter((p) => p.product !== input.product));
  }),
});
