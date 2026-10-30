// A licence's timestamp on Bitcoin (docs/work/ideas/onchain-licences.md R-4.6): the proof
// the store keeps for it (GET /ots/<id>), kept here too so it shows offline, and checked
// on this server with our own reader (contracts/ots.ts): the licence's SHA-256 must be
// the proof's digest, and its operations must lead to the merkle root of the block an
// explorer (OTS_EXPLORER) shows. Without a network it stays "unverified", never "failed".
import { createHash } from "node:crypto";
import { attestationsOf, merkleRootBytes, OtsError, parseProof, toHex } from "@contracts/ots";
import { env } from "../lib/env";
import { getServerSetting, setServerSetting } from "../lib/serverSettings";
import { postStore, StoreError } from "../store/client";

export type ProofStatus = "none" | "pending" | "complete" | "verified" | "unverified" | "failed";
export type LicenceProof = { status: ProofStatus; block: number | null; time: number | null; existedBy: boolean };

/** The store's record of a proof, as kept on this server. */
type Kept = { ots: string; status: "pending" | "complete"; block: number | null; backfilled: boolean };
const KEY = "licence-proofs";
const EXPLORER_TIMEOUT_MS = 10_000;

const none: LicenceProof = { status: "none", block: null, time: null, existedBy: false };

/** The proof from the store (kept here when it answers), else the one kept before; null when there is none. */
async function fetchProof(id: string): Promise<Kept | null> {
  const kept = await getServerSetting<Record<string, Kept>>(KEY, {});
  try {
    const res = await postStore(`/ots/${encodeURIComponent(id)}`, null, "GET");
    const body = (await res.json()) as { ots?: unknown; status?: unknown; block?: unknown; backfilled?: unknown };
    if (typeof body.ots !== "string" || (body.status !== "pending" && body.status !== "complete")) return kept[id] ?? null;
    const fresh: Kept = { ots: body.ots, status: body.status, block: typeof body.block === "number" ? body.block : null, backfilled: body.backfilled === true };
    if (JSON.stringify(kept[id]) !== JSON.stringify(fresh)) await setServerSetting(KEY, { ...kept, [id]: fresh });
    return fresh;
  } catch (e) {
    // Not stamped (404): none; the store out of reach: what was kept.
    if (e instanceof StoreError && e.code === "rejected") return null;
    return kept[id] ?? null;
  }
}

/** A block's merkle root and time from the explorer; null when it can't be asked now. */
async function blockOf(height: number): Promise<{ merkleRoot: string; time: number } | null> {
  const get = (path: string) => fetch(`${env.otsExplorer}${path}`, { redirect: "error", signal: AbortSignal.timeout(EXPLORER_TIMEOUT_MS) });
  try {
    const hashRes = await get(`/block-height/${height}`);
    if (!hashRes.ok) return null;
    const hash = (await hashRes.text()).trim();
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const blockRes = await get(`/block/${hash}`);
    if (!blockRes.ok) return null;
    const b = (await blockRes.json()) as { merkle_root?: unknown; timestamp?: unknown };
    return typeof b.merkle_root === "string" && typeof b.timestamp === "number" ? { merkleRoot: b.merkle_root, time: b.timestamp * 1000 } : null;
  } catch {
    return null;
  }
}

/** Where licence `id` (its text `licence`) stands on Bitcoin. */
export async function proofOf(id: string, licence: string): Promise<LicenceProof> {
  const kept = await fetchProof(id);
  if (!kept) return none;
  const existedBy = kept.backfilled;
  let proof;
  try {
    proof = parseProof(Uint8Array.from(Buffer.from(kept.ots, "base64")));
  } catch (e) {
    if (e instanceof OtsError) return { status: "failed", block: kept.block, time: null, existedBy };
    throw e;
  }
  // The proof is of this licence, or of nothing that matters here.
  if (toHex(proof.digest) !== createHash("sha256").update(licence, "utf8").digest("hex")) return { status: "failed", block: kept.block, time: null, existedBy };
  const bitcoin = (await attestationsOf(proof.timestamp, proof.digest)).reached.filter(
    (r): r is typeof r & { attestation: { kind: "bitcoin"; height: number } } => r.attestation.kind === "bitcoin",
  );
  if (bitcoin.length === 0) return { status: "pending", block: null, time: null, existedBy };
  // The earliest block that holds it, checked against the explorer.
  const first = bitcoin.reduce((a, b) => (b.attestation.height < a.attestation.height ? b : a));
  const block = await blockOf(first.attestation.height);
  if (!block) return { status: "unverified", block: first.attestation.height, time: null, existedBy };
  const ok = toHex(first.message) === toHex(merkleRootBytes(block.merkleRoot));
  return ok ? { status: "verified", block: first.attestation.height, time: block.time, existedBy } : { status: "failed", block: first.attestation.height, time: null, existedBy };
}

/** The proof as a file, to check with any OpenTimestamps tool; null when there is none. */
export async function proofFile(id: string): Promise<{ filename: string; base64: string } | null> {
  const kept = (await getServerSetting<Record<string, Kept>>(KEY, {}))[id] ?? (await fetchProof(id));
  return kept ? { filename: `${id}.ots`, base64: kept.ots } : null;
}
