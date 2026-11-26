// Who holds which licence (contracts/accounts.ts, docs/it/who-pays.md): one licence is one
// seat for one named person. Offers put a module in someone's Store for them to buy; an
// admin's or a team's purchase is one licence per person; a seat moves, it is never shared.
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { moduleLicences, moduleOffers, teamMembers, users } from "@db/schema";
import { getDb } from "../queries/connection";
import { can, grantsOf, storedGrants, type Account } from "../queries/accounts";
import { listModules, validLicenses } from "../modules/registry";

export type Payer = { kind: "user" | "team"; id: number | null };

/** The module id of a Store product (its manifest's, once installed; else the product's own name). */
export async function moduleIdOf(product: string): Promise<string> {
  return (await listModules()).find((m) => m.product === product)?.id ?? product.replace(/^inkledger\./, "");
}

/** The product of a module id (installed). */
export async function productOf(moduleId: string): Promise<string | undefined> {
  return (await listModules()).find((m) => m.id === moduleId)?.product;
}

/** The products offered to the account: to it, or to a team it is in (as the team is now). */
export async function offeredTo(userId: number): Promise<Set<string>> {
  const teamsOf = getDb().select({ id: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId));
  const rows = await getDb()
    .select({ product: moduleOffers.product })
    .from(moduleOffers)
    .where(or(eq(moduleOffers.userId, userId), inArray(moduleOffers.teamId, teamsOf)));
  return new Set(rows.map((r) => r.product));
}

/** May get this product for themselves: the whole catalogue (acquireModules held as such, a Store manager), or an offer. */
export async function mayAcquire(user: Account, product: string): Promise<boolean> {
  return can(user, "acquireModules") || (await offeredTo(user.id)).has(product);
}

/** Whether the account holds a licence of the product already. */
export async function holdsLicence(userId: number, product: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: moduleLicences.licenceId })
    .from(moduleLicences)
    .where(and(eq(moduleLicences.product, product), eq(moduleLicences.holderUserId, userId)))
    .limit(1);
  return Boolean(row);
}

/** The licences of a product with who holds and who paid each (none recorded: from before, a free seat). */
export async function ledgerOf(product: string) {
  const held = (await validLicenses()).filter((l) => l.product === product);
  const rows = held.length === 0 ? [] : await getDb().select().from(moduleLicences).where(inArray(moduleLicences.licenceId, held.map((l) => l.id)));
  return held.map((l) => {
    const r = rows.find((x) => x.licenceId === l.id);
    return { id: l.id, holderUserId: r?.holderUserId ?? null, payer: r ? { kind: r.payerKind === "team" ? ("team" as const) : ("user" as const), id: r.payerId } : null, boughtBy: r?.boughtBy ?? null };
  });
}

/** The licence a person holds of a product. */
export async function licenceOfHolder(userId: number, product: string) {
  return (await ledgerOf(product)).find((l) => l.holderUserId === userId);
}

/** Adds or takes away one module in an account's grants (row locked: a change in Settings › Users meanwhile is kept). */
async function setGrant(userId: number, moduleId: string, on: boolean) {
  await getDb().transaction(async (tx) => {
    const [row] = await tx.select({ moduleGrants: users.moduleGrants }).from(users).where(eq(users.id, userId)).for("update");
    if (!row) return;
    const held = grantsOf(row);
    const next = on ? [...new Set([...held, moduleId])] : held.filter((g) => g !== moduleId);
    if (next.length !== held.length) await tx.update(users).set({ moduleGrants: storedGrants(next) }).where(eq(users.id, userId));
  });
}

/**
 * A licence goes to one person: recorded with who paid and who bought it, and the module
 * granted to them. A licence already recorded keeps its payer (a reassignment moves only the holder).
 */
export async function assignSeat(o: { licenceId: string; product: string; holder: number; payer: Payer; boughtBy: number | null }) {
  await getDb()
    .insert(moduleLicences)
    .values({ licenceId: o.licenceId, product: o.product, holderUserId: o.holder, payerKind: o.payer.kind, payerId: o.payer.id, boughtBy: o.boughtBy })
    .onConflictDoUpdate({ target: moduleLicences.licenceId, set: { holderUserId: o.holder } });
  await setGrant(o.holder, await moduleIdOf(o.product), true);
}

/**
 * Moves a seat to another person: the holder changes, the payer stays, the old holder's
 * module goes (their saved progress stays, for when it comes back). Refused (false) for a
 * licence its holder paid for themselves: theirs to keep.
 */
export async function moveSeat(licenceId: string, to: number): Promise<"moved" | "own" | "missing" | "taken"> {
  const valid = (await validLicenses()).find((l) => l.id === licenceId);
  if (!valid) return "missing";
  const [row] = await getDb().select().from(moduleLicences).where(eq(moduleLicences.licenceId, licenceId)).limit(1);
  if (row && row.payerKind === "user" && row.payerId !== null && row.payerId === row.holderUserId) return "own";
  if (await holdsLicence(to, valid.product)) return "taken";
  const moduleId = await moduleIdOf(valid.product);
  if (row?.holderUserId) await setGrant(row.holderUserId, moduleId, false);
  if (row) await getDb().update(moduleLicences).set({ holderUserId: to }).where(eq(moduleLicences.licenceId, licenceId));
  else await getDb().insert(moduleLicences).values({ licenceId, product: valid.product, holderUserId: to, payerKind: "user", payerId: null, boughtBy: null });
  await setGrant(to, moduleId, true);
  return "moved";
}

/** People holding the module now (granted, not owners: an owner runs every module without a seat). */
async function grantedCount(moduleId: string, except: number) {
  const rows = await getDb().select({ id: users.id, grants: users.moduleGrants }).from(users).where(and(sql`${users.role} <> 'admin'`, isNull(users.disabledAt)));
  return rows.filter((r) => r.id !== except && grantsOf({ moduleGrants: r.grants }).includes(moduleId)).length;
}

/**
 * Settings › Users giving or taking modules: each one given takes a free seat (a licence of
 * the product nobody holds), each one taken frees the person's. False: no free seat for one
 * of them (nothing changed). Grants made before seats existed stay as they were.
 */
export async function seatsFor(userId: number, before: readonly string[], after: readonly string[]): Promise<{ ok: true } | { ok: false; moduleId: string }> {
  const added = after.filter((m) => !before.includes(m));
  for (const moduleId of added) {
    const product = await productOf(moduleId);
    if (!product) continue;
    if ((await ledgerOf(product)).length <= (await grantedCount(moduleId, userId))) return { ok: false, moduleId };
  }
  return { ok: true };
}

/** After Settings › Users wrote the grants: the seats follow (taken for what was given, freed for what was taken). */
export async function syncSeats(userId: number, before: readonly string[], after: readonly string[]) {
  for (const moduleId of after.filter((m) => !before.includes(m))) {
    const product = await productOf(moduleId);
    if (!product || (await holdsLicence(userId, product))) continue;
    const free = (await ledgerOf(product)).find((l) => l.holderUserId === null);
    if (!free) continue;
    await getDb()
      .insert(moduleLicences)
      .values({ licenceId: free.id, product, holderUserId: userId, payerKind: "user", payerId: null, boughtBy: null })
      .onConflictDoUpdate({ target: moduleLicences.licenceId, set: { holderUserId: userId } });
  }
  for (const moduleId of before.filter((m) => !after.includes(m))) {
    const product = await productOf(moduleId);
    if (!product) continue;
    await getDb().update(moduleLicences).set({ holderUserId: null }).where(and(eq(moduleLicences.product, product), eq(moduleLicences.holderUserId, userId), isNotNull(moduleLicences.holderUserId)));
  }
}

/** A licence removed from the server: its seat goes, and its holder's module with it. */
export async function dropSeat(licenceId: string) {
  const [row] = await getDb().delete(moduleLicences).where(eq(moduleLicences.licenceId, licenceId)).returning();
  if (row?.holderUserId) await setGrant(row.holderUserId, await moduleIdOf(row.product), false);
}

/** The products whose licence the account holds and paid for itself. */
export async function ownLicences(userId: number): Promise<string[]> {
  const rows = await getDb()
    .select({ product: moduleLicences.product })
    .from(moduleLicences)
    .where(and(eq(moduleLicences.holderUserId, userId), eq(moduleLicences.payerKind, "user"), eq(moduleLicences.payerId, userId)));
  return rows.map((r) => r.product).sort();
}
