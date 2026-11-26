import { activateNew, tokenFor } from "../modules/activation";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { HOST_API, SLOT_IDS, runsHere } from "@contracts/modules";
import { LICENSE_FILE_FORMAT, mediaUrl, pickBuild, type StoreCatalog, type StoreEntry, type StorePending } from "@contracts/store";
import { t, type MessageKey } from "@contracts/i18n";
import { createRouter, permProcedure } from "../middleware";
import { can, grantModule, userById, withAccess, type Account } from "../queries/accounts";
import { record, type AuditRequest } from "../lib/audit";
import { env } from "../lib/env";
import { getServerSetting, updateServerSetting } from "../lib/serverSettings";
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
  claimPaid,
  downloadBundle,
  fetchCatalog,
  forgetCatalog,
  requestLicense,
  startCheckout,
  tokenStatus,
} from "../store/client";

/** Server-wide: for whoever may manage the Store and licences (install, restore). */
const store = permProcedure("manageStore");
/**
 * The catalogue and getting a module not on the server yet (request, buy, claim, wait):
 * acquireModules (manageStore implies it). Someone who doesn't manage the Store only
 * acquires what the server holds no licence for, sees and dismisses only their own
 * pending entries, and gets the module granted to them alone once it lands.
 */
const acquire = permProcedure("acquireModules");

const manages = (user: Account) => can(user, "manageStore");

/**
 * Settings → Store. Requests and checkouts are kept in server_settings with
 * their Worker token (never sent to the page); `pending` polls the Worker and,
 * once a licence is there, stores it and installs the module like an upload.
 */

const PENDING_KEY = "store.pending";
const PAID_MAX_AGE_MS = 30 * 86_400_000;

/** by: who asked or paid (older entries have none: a Store manager's, granted to nobody). */
type Stored = StorePending & { token: string; created: number; by?: number };

const readPending = () => getServerSetting<Stored[]>(PENDING_KEY, []);
/** The pending list changed from what it is now, in one step: a poll and a click at once keep each other's change. */
const updatePending = (change: (list: Stored[]) => Stored[]) => updateServerSetting<Stored[]>(PENDING_KEY, [], change);
const publicPending = ({ product, kind, status, reason }: Stored): StorePending =>
  reason ? { product, kind, status, reason } : { product, kind, status };

const ERRORS: Record<string, MessageKey> = {
  email: "server.store.email",
  rate: "server.store.rate",
  requested: "server.store.requested",
  product: "server.store.product",
  method: "server.store.method",
  code: "server.store.code",
  pending: "server.store.codePending",
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

type Settled = { next: Stored | null; installed: boolean; id?: string };

/** One pending entry against the Worker: installed (gone), kept, updated or dropped. */
async function settle(p: Stored): Promise<Settled> {
  const keep = (next: Stored | null): Settled => ({ next, installed: false });
  if (p.status !== "pending") return keep(p);
  // A checkout waits for its payer's code (claimPaid), never for its token; an abandoned one goes.
  if (p.kind === "paid") return keep(Date.now() - p.created > PAID_MAX_AGE_MS ? null : p);
  const s = await tokenStatus(p.token);
  // The Worker forgot it: the request says so.
  if (!s) return keep({ ...p, status: "failed", reason: "expired" });
  if (s.status === "declined") return keep({ ...p, status: "declined" });
  if (!s.license) return keep(p);
  const l = await addLicense(s.license);
  if (!l.ok) return keep({ ...p, status: "failed", reason: l.reason });
  // Bought or approved: this server takes its slot now (over the limit, the licence waits: Settings says so).
  await activateNew(s.license, l.payload.id);
  const installed = installBundle(await downloadBundle(p.product, p.token));
  // An older version than the installed one is fine: the licence is what was missing.
  if (!installed.ok && installed.reason !== "older-version") return keep({ ...p, status: "failed", reason: installed.reason });
  return { next: null, installed: true, id: installed.ok ? installed.id : undefined };
}

/**
 * A module acquired by someone who doesn't manage the Store is granted to them, and only
 * them (a manager grants modules in Settings › Users, so theirs grants nobody). Without
 * useModules the grant waits: it runs once they are given it.
 */
async function grantToAcquirer(who: AuditRequest, product: string, by: number | undefined, id: string | undefined) {
  if (by === undefined) return;
  const found = await userById(by);
  if (!found || found.disabledAt) return;
  if (manages(await withAccess(found))) return;
  const moduleId = id ?? (await listModules()).find((m) => m.product === product)?.id;
  if (!moduleId || !(await grantModule(by, moduleId))) return;
  await record(who, "store.grantAcquired", { target: { type: "users", id: by, ownerUserId: by }, after: { product, moduleId, userId: by } });
}

/**
 * Whether this account may start getting the product: a Store manager always; anyone
 * else only for a module the server holds no licence for (else acquiring would grant
 * them one already here, which is Settings › Users' to give), nobody else is getting.
 */
async function assertMayAcquire(user: Account, product: string) {
  if (manages(user)) return;
  const [{ licensed }, pending] = await Promise.all([licenseStates(), readPending()]);
  if (licensed.has(product)) throw new TRPCError({ code: "FORBIDDEN", message: t("server.store.alreadyHere") });
  if (pending.some((p) => p.product === product && p.status === "pending" && p.by !== user.id)) throw new TRPCError({ code: "FORBIDDEN", message: t("server.store.pendingOther") });
}

/** The pending entries an account sees: all of them for a Store manager, else its own. */
const visibleTo = (user: Account) => (p: Stored) => manages(user) || p.by === user.id;

/**
 * A build the Store hands this inkledger: it is told the host API range this one
 * runs (HOST_API) and its slots, and picks the newest build that meets both.
 */
const servable = runsHere;
/** A build that waits for a newer inkledger: a host API above this one's, or a slot it doesn't know. */
const needsNewerHost = (b: { hostApi: { min: number; max: number }; slots: readonly string[] }) =>
  b.hostApi.min > HOST_API.max || !b.slots.every((s) => (SLOT_IDS as readonly string[]).includes(s));

export const storeRouter = createRouter({
  catalog: acquire.query(async ({ ctx }): Promise<StoreCatalog> => {
    if (!env.storeUrl) return { enabled: false, entries: [] };
    const items = await fetchCatalog().catch(storeFailure);
    const [modules, { licensed: products }, pending] = await Promise.all([listModules(), licenseStates(), readPending()]);
    const entries = items.map((item): StoreEntry => {
      const installed = modules.find((m) => m.product === item.product);
      const p = pending.filter(visibleTo(ctx.user)).find((x) => x.product === item.product);
      const { build, newerElsewhere } = pickBuild(item, servable, older, needsNewerHost);
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

  requestLicense: acquire
    .input(
      z.object({
        product,
        email: z.email().max(254),
        message: z.string().max(2000).default(""),
        locale: z.enum(["en", "it"]).default("en"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await assertMayAcquire(ctx.user, input.product);
      const token = await requestLicense(input).catch(storeFailure);
      await updatePending((list) => [...list.filter((p) => p.product !== input.product), { token, product: input.product, kind: "request", status: "pending", created: Date.now(), by: ctx.user.id }]);
      return { ok: true as const };
    }),

  checkout: acquire
    .input(z.object({ product, method: z.enum(["card", "bitcoin"]), email: z.email().max(254).optional() }))
    .mutation(async ({ input, ctx }) => {
      await assertMayAcquire(ctx.user, input.product);
      // Prefills the checkout; a tracker login is no email.
      const email = input.email ?? (z.email().safeParse(ctx.user.email).success ? ctx.user.email : undefined);
      const { token, url } = await startCheckout(email ? { ...input, email } : input).catch(async (e: unknown) => {
        await forgetCatalog();
        return storeFailure(e);
      });
      await updatePending((list) => [...list.filter((p) => p.product !== input.product), { token, product: input.product, kind: "paid", status: "pending", created: Date.now(), by: ctx.user.id }]);
      return { url };
    }),

  /** A paid order's licence, for the code its payer was shown after paying: stored, activated, installed. */
  claimPaid: acquire.input(z.object({ product, code: z.string().trim().min(1).max(64) })).mutation(async ({ input, ctx }) => {
    // Someone who doesn't manage the Store claims only the purchase they started here.
    if (!manages(ctx.user) && !(await readPending()).some((p) => p.product === input.product && p.kind === "paid" && p.by === ctx.user.id)) {
      throw new TRPCError({ code: "FORBIDDEN", message: t("server.store.notYours") });
    }
    const { license, product: bought } = await claimPaid(input.code).catch(storeFailure);
    if (bought !== input.product) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.store.codeProduct") });
    const l = await addLicense(license);
    if (!l.ok) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.store.badLicence") });
    await activateNew(license, l.payload.id);
    const installed = installBundle(await bundleForLicense(input.product, license, await tokenFor(l.payload.id)).catch(storeFailure));
    // An older version than the installed one is fine: the licence is what was missing.
    if (!installed.ok && installed.reason !== "older-version") throw new TRPCError({ code: "BAD_REQUEST", message: t("server.store.installFailed", { reason: installed.reason }) });
    await updatePending((list) => list.filter((p) => p.product !== input.product));
    await grantToAcquirer(ctx, input.product, ctx.user.id, installed.ok ? installed.id : undefined);
    return { ok: true as const };
  }),

  /** Polled by the page while something is pending; installs what has arrived. */
  pending: acquire.query(async ({ ctx }) => {
    const before = await readPending();
    if (before.length === 0) return { pending: [], installed: [] as string[] };
    const after: Stored[] = [];
    const installed: string[] = [];
    const mine = visibleTo(ctx.user);
    for (const p of before) {
      // Unreachable or a failed download: try again next time.
      const r = await settle(p).catch((): Settled => ({ next: p, installed: false }));
      if (r.next) after.push(r.next);
      if (r.installed) {
        // Whoever polls, the module goes to whoever acquired it.
        await grantToAcquirer(ctx, p.product, p.by, r.id);
        if (mine(p)) installed.push(p.product);
      }
    }
    // Only what this poll changed; a request saved meanwhile is kept.
    const merged = await updatePending((current) =>
      current.flatMap((c) => {
        const was = before.find((b) => b.token === c.token);
        if (!was) return [c];
        const now = after.find((a) => a.token === c.token);
        return now ? [now] : [];
      }),
    );
    return { pending: merged.filter(mine).map(publicPending), installed };
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
  dismiss: acquire.input(z.object({ product })).mutation(async ({ input, ctx }) => {
    const mine = visibleTo(ctx.user);
    if ((await readPending()).some((p) => p.product === input.product && !mine(p))) throw new TRPCError({ code: "FORBIDDEN", message: t("server.store.notYours") });
    await updatePending((list) => list.filter((p) => p.product !== input.product || !mine(p)));
  }),
});
