import { activateNew, tokenFor } from "../modules/activation";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { HOST_API, SLOT_IDS, runsHere } from "@contracts/modules";
import { LICENSE_FILE_FORMAT, mediaUrl, pickBuild, type StoreCatalog, type StoreEntry, type StorePending } from "@contracts/store";
import { t, type MessageKey } from "@contracts/i18n";
import { createRouter, permProcedure } from "../middleware";
import { can, mayRunModule, type Account } from "../queries/accounts";
import { record, type AuditRequest } from "../lib/audit";
import { getDb } from "../queries/connection";
import { moduleOffers, teamMembers, teams, users } from "@db/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { assignSeat, holdsLicence, ledgerOf, mayAcquire, moveSeat, offeredTo, type Payer } from "../store/seats";
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

/** Server-wide: for whoever may manage the Store and licences (install, restore, offer, assign, reassign). */
const store = permProcedure("manageStore");
/**
 * Getting a module for oneself (catalogue, request, buy, claim, wait): useModules, then per
 * product in the handler: the whole catalogue with acquireModules (manageStore implies it),
 * else what a Store manager offered to the account or its team. Every licence is one named
 * person's (docs/it/who-pays.md): bought for oneself it is one's own; someone who doesn't
 * manage the Store sees and dismisses only their own pending entries.
 */
const buy = permProcedure("useModules");

const manages = (user: Account) => can(user, "manageStore");

/**
 * Settings → Store. Requests and checkouts are kept in server_settings with
 * their Worker token (never sent to the page); `pending` polls the Worker and,
 * once a licence is there, stores it and installs the module like an upload.
 */

const PENDING_KEY = "store.pending";
const PAID_MAX_AGE_MS = 30 * 86_400_000;

/**
 * by: who started it; for: whose licence it will be (one person, always); payer: who pays
 * (that person, an admin, a team). Older entries have none: a Store manager's, a free seat.
 */
type Stored = StorePending & { token: string; created: number; by?: number; for?: number; payer?: Payer };

/** Whose licence an entry will be (older ones: whoever started it, if known). */
const beneficiary = (p: Stored) => p.for ?? p.by;

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

type Settled = { next: Stored | null; installed: boolean; licenceId?: string };

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
  return { next: null, installed: true, licenceId: l.payload.id };
}

/** A licence that landed goes to the person it was got for, with who paid and who bought it. */
async function seat(who: AuditRequest, product: string, licenceId: string, p: { for?: number; by?: number; payer?: Payer }) {
  const holder = p.for ?? p.by;
  if (holder === undefined) return;
  const payer = p.payer ?? { kind: "user" as const, id: p.by ?? holder };
  await assignSeat({ licenceId, product, holder, payer, boughtBy: p.by ?? null });
  await record(who, "store.grantAcquired", { target: { type: "users", id: holder, ownerUserId: holder }, after: { product, moduleId: product.replace(/^inkledger\./, ""), userId: holder, payerKind: payer.kind, payerId: payer.id } });
}

/**
 * Whether this account may start getting the product for itself: offered to it (or the whole
 * catalogue), and not holding a licence of it already (one licence per person, never two).
 */
async function assertMayAcquire(user: Account, product: string) {
  if (!(await mayAcquire(user, product))) throw new TRPCError({ code: "FORBIDDEN", message: t("server.store.notOffered") });
  if (await holdsLicence(user.id, product)) throw new TRPCError({ code: "FORBIDDEN", message: t("server.store.alreadyYours") });
}

/** The pending entries an account sees: all of them for a Store manager, else the ones it started or that are for it. */
const visibleTo = (user: Account) => (p: Stored) => manages(user) || p.by === user.id || p.for === user.id;
/** The entry that is this account's own for a product (what its card shows). */
const ownEntry = (user: Account, list: Stored[], product: string) =>
  list.find((p) => p.product === product && beneficiary(p) === user.id) ?? (manages(user) ? list.find((p) => p.product === product && beneficiary(p) === undefined) : undefined);

/** A person's address the admin may use for their licence request (shown and editable before it goes). */
const addressOf = (email: string) => (z.email().safeParse(email).success ? email : "");

/**
 * A build the Store hands this inkledger: it is told the host API range this one
 * runs (HOST_API) and its slots, and picks the newest build that meets both.
 */
const servable = runsHere;
/** A build that waits for a newer inkledger: a host API above this one's, or a slot it doesn't know. */
const needsNewerHost = (b: { hostApi: { min: number; max: number }; slots: readonly string[] }) =>
  b.hostApi.min > HOST_API.max || !b.slots.every((s) => (SLOT_IDS as readonly string[]).includes(s));

export const storeRouter = createRouter({
  catalog: buy.query(async ({ ctx }): Promise<StoreCatalog> => {
    // Without acquireModules: only what was offered to the account (or its team), and what it holds.
    const whole = can(ctx.user, "acquireModules");
    const offered = whole ? new Set<string>() : await offeredTo(ctx.user.id);
    if (!whole && offered.size === 0) throw new TRPCError({ code: "FORBIDDEN", message: t("server.auth.notAllowed") });
    if (!env.storeUrl) return { enabled: false, entries: [] };
    const all = await fetchCatalog().catch(storeFailure);
    const [modules, { licensed: products }, pending] = await Promise.all([listModules(), licenseStates(), readPending()]);
    const mine = (product: string) => {
      const m = modules.find((x) => x.product === product);
      return !!m && mayRunModule(ctx.user, m.id);
    };
    const items = whole ? all : all.filter((item) => offered.has(item.product) || mine(item.product));
    const entries = items.map((item): StoreEntry => {
      const installed = modules.find((m) => m.product === item.product);
      const p = ownEntry(ctx.user, pending, item.product);
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
        // A Store manager sees the server's licences; anyone else whether they hold one (theirs, one per person).
        licensed: manages(ctx.user) ? products.has(item.product) : mine(item.product),
        supported: build !== null,
        needsNewerHost: newerElsewhere,
        pending: p ? publicPending(p) : null,
      };
    });
    return { enabled: true, entries };
  }),

  requestLicense: buy
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
      const me = ctx.user.id;
      await updatePending((list) => [...list.filter((p) => !(p.product === input.product && beneficiary(p) === me)), { token, product: input.product, kind: "request", status: "pending", created: Date.now(), by: me, for: me, payer: { kind: "user", id: me } }]);
      return { ok: true as const };
    }),

  checkout: buy
    .input(z.object({ product, method: z.enum(["card", "bitcoin"]), email: z.email().max(254).optional() }))
    .mutation(async ({ input, ctx }) => {
      await assertMayAcquire(ctx.user, input.product);
      // Prefills the checkout; a tracker login is no email.
      const email = input.email ?? (z.email().safeParse(ctx.user.email).success ? ctx.user.email : undefined);
      const { token, url } = await startCheckout(email ? { ...input, email } : input).catch(async (e: unknown) => {
        await forgetCatalog();
        return storeFailure(e);
      });
      const me = ctx.user.id;
      await updatePending((list) => [...list.filter((p) => !(p.product === input.product && beneficiary(p) === me)), { token, product: input.product, kind: "paid", status: "pending", created: Date.now(), by: me, for: me, payer: { kind: "user", id: me } }]);
      return { url };
    }),

  /** A paid order's licence, for the code its payer was shown after paying: stored, activated, installed. */
  claimPaid: buy.input(z.object({ product, code: z.string().trim().min(1).max(64), for: z.number().int().optional() })).mutation(async ({ input, ctx }) => {
    // Whose licence it is: one's own, or (a Store manager) the person a purchase was assigned to.
    const whose = input.for ?? ctx.user.id;
    if (whose !== ctx.user.id && !manages(ctx.user)) throw new TRPCError({ code: "FORBIDDEN", message: t("server.store.notYours") });
    const entry = (await readPending()).find((p) => p.product === input.product && p.kind === "paid" && beneficiary(p) === whose && (manages(ctx.user) || p.by === ctx.user.id));
    if (!entry && !manages(ctx.user)) throw new TRPCError({ code: "FORBIDDEN", message: t("server.store.notYours") });
    const { license, product: bought } = await claimPaid(input.code).catch(storeFailure);
    if (bought !== input.product) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.store.codeProduct") });
    const l = await addLicense(license);
    if (!l.ok) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.store.badLicence") });
    await activateNew(license, l.payload.id);
    const installed = installBundle(await bundleForLicense(input.product, license, await tokenFor(l.payload.id)).catch(storeFailure));
    // An older version than the installed one is fine: the licence is what was missing.
    if (!installed.ok && installed.reason !== "older-version") throw new TRPCError({ code: "BAD_REQUEST", message: t("server.store.installFailed", { reason: installed.reason }) });
    await updatePending((list) => list.filter((p) => (entry ? p.token !== entry.token : !(p.product === input.product && beneficiary(p) === whose))));
    await seat(ctx, input.product, l.payload.id, entry ?? { for: whose, by: ctx.user.id });
    return { ok: true as const };
  }),

  /** Polled by the page while something is pending; installs what has arrived. */
  pending: buy.query(async ({ ctx }) => {
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
        // Whoever polls, the licence goes to the person it was got for.
        // A seat that can't be recorded (its person already holds one meanwhile) never blocks the poll: the licence stays, free.
        if (r.licenceId) await seat(ctx, p.product, r.licenceId, p).catch((e: unknown) => console.error("[store] seat", e));
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
  dismiss: buy.input(z.object({ product, for: z.number().int().optional() })).mutation(async ({ input, ctx }) => {
    const whose = input.for ?? ctx.user.id;
    if (whose !== ctx.user.id && !manages(ctx.user)) throw new TRPCError({ code: "FORBIDDEN", message: t("server.store.notYours") });
    const mine = visibleTo(ctx.user);
    const hit = (p: Stored) => p.product === input.product && mine(p) && (beneficiary(p) === whose || (input.for === undefined && manages(ctx.user) && beneficiary(p) === undefined));
    await updatePending((list) => list.filter((p) => !hit(p)));
  }),

  /** One's own licence of a product, as a file (bought by oneself: the buyer side manages a licence). */
  myLicence: buy.input(z.object({ product: z.string().min(1) })).query(async ({ input, ctx }) => {
    const l = (await ledgerOf(input.product)).find((x) => x.holderUserId === ctx.user.id);
    if (!l || l.payer?.kind !== "user" || l.payer.id !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND", message: t("server.store.noLicense") });
    const text = (await validLicenses()).find((x) => x.id === l.id)?.text;
    if (!text) throw new TRPCError({ code: "NOT_FOUND", message: t("server.store.noLicense") });
    return { format: LICENSE_FILE_FORMAT, product: input.product, license: text };
  }),

  /** Who gets a module: its offers, its licences (holder, payer), what waits, and the people and teams to pick from. */
  distribution: store.input(z.object({ product })).query(async ({ input }) => {
    const db = getDb();
    const [people, teamRows, members, offers, ledger, pending] = await Promise.all([
      db.select({ id: users.id, displayName: users.displayName, username: users.username, email: users.email }).from(users).where(isNull(users.disabledAt)).orderBy(asc(users.displayName)),
      db.select({ id: teams.id, name: teams.name }).from(teams).orderBy(asc(teams.name)),
      db.select({ teamId: teamMembers.teamId, userId: teamMembers.userId }).from(teamMembers),
      db.select({ id: moduleOffers.id, userId: moduleOffers.userId, teamId: moduleOffers.teamId }).from(moduleOffers).where(eq(moduleOffers.product, input.product)),
      ledgerOf(input.product),
      readPending(),
    ]);
    return {
      people: people.map((p) => ({ id: p.id, name: p.displayName, username: p.username, email: addressOf(p.email) })),
      teams: teamRows.map((tm) => ({ ...tm, members: members.filter((m) => m.teamId === tm.id).map((m) => m.userId) })),
      offers,
      licences: ledger.map((l) => ({ id: l.id, label: l.id.length > 6 ? `${l.id.slice(0, 6)}…` : l.id, holderUserId: l.holderUserId, payer: l.payer })),
      pending: pending.filter((p) => p.product === input.product && p.for !== undefined).map((p) => ({ for: p.for ?? 0, kind: p.kind, status: p.status, payer: p.payer ?? null })),
    };
  }),

  /** Puts a module in one person's or one team's Store: they buy or request it for themselves. */
  offer: store
    .input(z.union([z.object({ product, userId: z.number().int() }), z.object({ product, teamId: z.number().int() })]))
    .mutation(async ({ input, ctx }) => {
      const to = "userId" in input ? { userId: input.userId, teamId: null } : { userId: null, teamId: input.teamId };
      await getDb().insert(moduleOffers).values({ product: input.product, ...to, offeredBy: ctx.user.id }).onConflictDoNothing();
      ctx.audit.set({ target: { type: "store", id: input.product }, after: { product: input.product, ...to } });
    }),

  withdrawOffer: store.input(z.object({ id: z.number().int() })).mutation(async ({ input, ctx }) => {
    const [gone] = await getDb().delete(moduleOffers).where(eq(moduleOffers.id, input.id)).returning();
    ctx.audit.set({ target: { type: "store", id: gone?.product ?? input.id }, after: gone ? { product: gone.product, userId: gone.userId, teamId: gone.teamId } : {} });
  }),

  /**
   * Buys or requests one licence PER PERSON, paid by the admin or by a team (its members
   * only): never one licence for several. Whoever holds or awaits one already is skipped. The
   * addresses go to the Store as the admin confirmed them; a paid one opens one checkout each.
   */
  assign: store
    .input(
      z.object({
        product,
        kind: z.enum(["request", "paid"]),
        method: z.enum(["card", "bitcoin"]).default("card"),
        teamId: z.number().int().optional(),
        people: z.array(z.object({ userId: z.number().int(), email: z.email().max(254) })).min(1).max(100),
        message: z.string().max(2000).default(""),
        locale: z.enum(["en", "it"]).default("en"),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      if (input.teamId !== undefined) {
        const inTeam = new Set((await db.select({ userId: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.teamId, input.teamId))).map((m) => m.userId));
        if (input.people.some((p) => !inTeam.has(p.userId))) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.store.notInTeam") });
      }
      const payer: Payer = input.teamId !== undefined ? { kind: "team", id: input.teamId } : { kind: "user", id: ctx.user.id };
      const waiting = await readPending();
      const started: { userId: number; url?: string }[] = [];
      const skipped: number[] = [];
      const failed: { userId: number; message: string }[] = [];
      for (const person of new Map(input.people.map((p) => [p.userId, p])).values()) {
        const [exists] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, person.userId), isNull(users.disabledAt))).limit(1);
        if (!exists) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.store.notInTeam") });
        if ((await holdsLicence(person.userId, input.product)) || waiting.some((p) => p.product === input.product && p.status === "pending" && beneficiary(p) === person.userId)) {
          skipped.push(person.userId);
          continue;
        }
        try {
          const got =
            input.kind === "request"
              ? { token: await requestLicense({ product: input.product, email: person.email, message: input.message, locale: input.locale }), url: undefined }
              : await startCheckout({ product: input.product, method: input.method, email: person.email });
          await updatePending((list) => [
            ...list.filter((p) => !(p.product === input.product && beneficiary(p) === person.userId)),
            { token: got.token, product: input.product, kind: input.kind, status: "pending", created: Date.now(), by: ctx.user.id, for: person.userId, payer },
          ]);
          started.push(got.url ? { userId: person.userId, url: got.url } : { userId: person.userId });
        } catch (e) {
          failed.push({ userId: person.userId, message: e instanceof Error ? e.message : String(e) });
        }
      }
      ctx.audit.set({ target: { type: "store", id: input.product }, after: { product: input.product, kind: input.kind, count: started.length, skipped: skipped.length, teamId: input.teamId ?? null } });
      return { started, skipped, failed };
    }),

  /** Moves a licence to another person (the payer stays; never one its holder paid for themselves). */
  reassign: store.input(z.object({ licence: z.string().min(1).max(64), userId: z.number().int() })).mutation(async ({ input, ctx }) => {
    const r = await moveSeat(input.licence, input.userId);
    if (r === "missing") throw new TRPCError({ code: "NOT_FOUND", message: t("server.store.noLicense") });
    if (r === "own") throw new TRPCError({ code: "FORBIDDEN", message: t("server.store.ownLicence") });
    if (r === "taken") throw new TRPCError({ code: "BAD_REQUEST", message: t("server.store.alreadyHolds") });
    ctx.audit.set({ target: { type: "users", id: input.userId, ownerUserId: input.userId }, after: { licence: input.licence, userId: input.userId } });
  }),
});
