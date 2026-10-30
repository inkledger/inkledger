// OpenTimestamps proofs (.ots), read and written without dependencies
// (docs/work/ideas/onchain-licences.md; the format of python-opentimestamps):
// a digest, then a tree of operations (hashes, appends, prepends) whose
// leaves are attestations: "pending at this calendar" or "in this Bitcoin
// block". Hashing goes through WebCrypto, the same in Node and in Workers.

const MAGIC = new Uint8Array([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74, 0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66, 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84,
  0xe8, 0x92, 0x94,
]);
const VERSION = 1;
const BITCOIN_TAG = new Uint8Array([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);
const PENDING_TAG = new Uint8Array([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e]);
const MAX_DEPTH = 256;
const MAX_ARG = 4096;

export class OtsError extends Error {}

export type OpName = "sha256" | "sha1" | "ripemd160" | "keccak256" | "append" | "prepend" | "reverse" | "hexlify";
const OP_TAGS: Record<OpName, number> = { sha1: 0x02, ripemd160: 0x03, sha256: 0x08, keccak256: 0x67, append: 0xf0, prepend: 0xf1, reverse: 0xf2, hexlify: 0xf3 };
const OP_BY_TAG = new Map(Object.entries(OP_TAGS).map(([k, v]) => [v, k as OpName]));
const BINARY = new Set<OpName>(["append", "prepend"]);

export type Op = { name: OpName; arg?: Uint8Array };
export type Attestation = { kind: "bitcoin"; height: number } | { kind: "pending"; uri: string } | { kind: "unknown"; tag: Uint8Array; payload: Uint8Array };
export type Timestamp = { attestations: Attestation[]; ops: { op: Op; next: Timestamp }[] };
export type DetachedProof = { digest: Uint8Array; timestamp: Timestamp };

// ── bytes ──

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const compare = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.length - b.length;
};
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => {
  if (!/^(?:[0-9a-f]{2})*$/i.test(h)) throw new OtsError("not hex");
  return new Uint8Array(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
};

class Reader {
  at = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }
  byte(): number {
    const v = this.b[this.at];
    if (v === undefined) throw new OtsError("truncated proof");
    this.at++;
    return v;
  }
  bytes(n: number): Uint8Array {
    if (this.at + n > this.b.length) throw new OtsError("truncated proof");
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  varuint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return value;
      shift += 7;
      if (shift > 49) throw new OtsError("varuint too long");
    }
  }
  varbytes(max: number): Uint8Array {
    const n = this.varuint();
    if (n > max) throw new OtsError("field too long");
    return this.bytes(n);
  }
}

const varuint = (n: number): Uint8Array => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return new Uint8Array(out);
};
const varbytes = (b: Uint8Array) => concat(varuint(b.length), b);

// ── operations ──

// RIPEMD-160 (older proofs hash the digest with it before it goes into a Bitcoin
// transaction); WebCrypto has no RIPEMD-160. Little-endian words, 80 steps per line.
const RL = Uint8Array.from([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13]);
const RR = Uint8Array.from([5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11]);
const SL = Uint8Array.from([11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6]);
const SR = Uint8Array.from([8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11]);
const KL = Uint32Array.from([0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e]);
const KR = Uint32Array.from([0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000]);
/** A table's entry (always in range here: the tables are fixed). */
const word = (a: Uint8Array | Uint32Array, i: number) => a[i] ?? 0;
const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
const f = (j: number, x: number, y: number, z: number) =>
  j < 16 ? x ^ y ^ z : j < 32 ? (x & y) | (~x & z) : j < 48 ? (x | ~y) ^ z : j < 64 ? (x & z) | (y & ~z) : x ^ (y | ~z);

export function ripemd160(msg: Uint8Array): Uint8Array {
  const bitLen = msg.length * 8;
  const padded = new Uint8Array(((msg.length + 8) >> 6) * 64 + 64);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  for (let off = 0; off < padded.length; off += 64) {
    const x = Uint32Array.from({ length: 16 }, (_, i) => view.getUint32(off + i * 4, true));
    let al = h0, bl = h1, cl = h2, dl = h3, el = h4;
    let ar = h0, br = h1, cr = h2, dr = h3, er = h4;
    for (let j = 0; j < 80; j++) {
      const r = j >> 4;
      let t = (rotl((al + f(j, bl, cl, dl) + word(x, word(RL, j)) + word(KL, r)) | 0, word(SL, j)) + el) | 0;
      al = el; el = dl; dl = rotl(cl, 10); cl = bl; bl = t;
      t = (rotl((ar + f(79 - j, br, cr, dr) + word(x, word(RR, j)) + word(KR, r)) | 0, word(SR, j)) + er) | 0;
      ar = er; er = dr; dr = rotl(cr, 10); cr = br; br = t;
    }
    const t = (h1 + cl + dr) | 0;
    h1 = (h2 + dl + er) | 0;
    h2 = (h3 + el + ar) | 0;
    h3 = (h4 + al + br) | 0;
    h4 = (h0 + bl + cr) | 0;
    h0 = t;
  }
  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h >>> 0, true));
  return out;
}

async function digestOf(alg: "SHA-256" | "SHA-1", msg: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg, new Uint8Array(msg)));
}

/** An operation applied to a message; null when this build can't compute it (Keccak-256). */
export async function apply(op: Op, msg: Uint8Array): Promise<Uint8Array | null> {
  switch (op.name) {
    case "sha256":
      return digestOf("SHA-256", msg);
    case "sha1":
      return digestOf("SHA-1", msg);
    case "ripemd160":
      return ripemd160(msg);
    case "append":
      return concat(msg, op.arg!);
    case "prepend":
      return concat(op.arg!, msg);
    case "reverse":
      return msg.slice().reverse();
    case "hexlify":
      return new TextEncoder().encode(toHex(msg));
    default:
      return null;
  }
}

// ── reading ──

function readOp(r: Reader, tag: number): Op {
  const name = OP_BY_TAG.get(tag);
  if (!name) throw new OtsError(`unknown operation 0x${tag.toString(16)}`);
  return BINARY.has(name) ? { name, arg: r.varbytes(MAX_ARG) } : { name };
}

function readAttestation(r: Reader): Attestation {
  const tag = r.bytes(8);
  const payload = new Reader(r.varbytes(8192));
  if (equal(tag, BITCOIN_TAG)) return { kind: "bitcoin", height: payload.varuint() };
  if (equal(tag, PENDING_TAG)) return { kind: "pending", uri: new TextDecoder().decode(payload.varbytes(1000)) };
  return { kind: "unknown", tag: tag.slice(), payload: payload.b.slice() };
}

function readTimestamp(r: Reader, depth = 0): Timestamp {
  if (depth > MAX_DEPTH) throw new OtsError("proof too deep");
  const ts: Timestamp = { attestations: [], ops: [] };
  const item = (tag: number) => {
    if (tag === 0x00) ts.attestations.push(readAttestation(r));
    else {
      const op = readOp(r, tag);
      ts.ops.push({ op, next: readTimestamp(r, depth + 1) });
    }
  };
  let tag = r.byte();
  while (tag === 0xff) {
    item(r.byte());
    tag = r.byte();
  }
  item(tag);
  return ts;
}

/** A detached proof (.ots) of a SHA-256 digest; throws OtsError when it isn't one. */
export function parseProof(bytes: Uint8Array): DetachedProof {
  const r = new Reader(bytes);
  if (!equal(r.bytes(MAGIC.length), MAGIC)) throw new OtsError("not an OpenTimestamps proof");
  if (r.varuint() !== VERSION) throw new OtsError("unsupported proof version");
  if (r.byte() !== OP_TAGS.sha256) throw new OtsError("only SHA-256 digests are supported");
  const digest = r.bytes(32).slice();
  const timestamp = readTimestamp(r);
  if (r.at !== bytes.length) throw new OtsError("trailing bytes after the proof");
  return { digest, timestamp };
}

/** A timestamp as a calendar answers it (no header), for the message it was asked about. */
export function parseTimestamp(bytes: Uint8Array): Timestamp {
  const r = new Reader(bytes);
  const ts = readTimestamp(r);
  if (r.at !== bytes.length) throw new OtsError("trailing bytes after the timestamp");
  return ts;
}

// ── writing (sorted as the reference implementation does) ──

const opBytes = (op: Op) => (op.arg ? concat(new Uint8Array([OP_TAGS[op.name]]), varbytes(op.arg)) : new Uint8Array([OP_TAGS[op.name]]));
const attestationBytes = (a: Attestation) => {
  if (a.kind === "bitcoin") return concat(BITCOIN_TAG, varbytes(varuint(a.height)));
  if (a.kind === "pending") return concat(PENDING_TAG, varbytes(varbytes(new TextEncoder().encode(a.uri))));
  return concat(a.tag, varbytes(a.payload));
};

export function serializeTimestamp(ts: Timestamp): Uint8Array {
  const atts = ts.attestations.map(attestationBytes).sort(compare);
  const ops = [...ts.ops].sort((a, b) => compare(opBytes(a.op), opBytes(b.op)));
  const lastAtt = atts.pop();
  const lastOp = ops.pop();
  if (!lastAtt && !lastOp) throw new OtsError("an empty timestamp can't be written");
  const out: Uint8Array[] = [];
  for (const a of atts) out.push(new Uint8Array([0xff, 0x00]), a);
  if (!lastOp) {
    if (lastAtt) out.push(new Uint8Array([0x00]), lastAtt);
  } else {
    if (lastAtt) out.push(new Uint8Array([0xff, 0x00]), lastAtt);
    for (const o of ops) out.push(new Uint8Array([0xff]), opBytes(o.op), serializeTimestamp(o.next));
    out.push(opBytes(lastOp.op), serializeTimestamp(lastOp.next));
  }
  return concat(...out);
}

export function serializeProof(p: DetachedProof): Uint8Array {
  return concat(MAGIC, varuint(VERSION), new Uint8Array([OP_TAGS.sha256]), p.digest, serializeTimestamp(p.timestamp));
}

// ── merging and walking ──

const sameOp = (a: Op, b: Op) => a.name === b.name && (a.arg === undefined ? b.arg === undefined : b.arg !== undefined && equal(a.arg, b.arg));
const sameAttestation = (a: Attestation, b: Attestation) => equal(attestationBytes(a), attestationBytes(b));

/** Both timestamps of the same message, as one (what a calendar answers merged into the proof). */
export function mergeTimestamps(a: Timestamp, b: Timestamp): Timestamp {
  const attestations = [...a.attestations];
  for (const x of b.attestations) if (!attestations.some((y) => sameAttestation(x, y))) attestations.push(x);
  const ops = a.ops.map((o) => {
    const same = b.ops.find((x) => sameOp(x.op, o.op));
    return same ? { op: o.op, next: mergeTimestamps(o.next, same.next) } : o;
  });
  for (const o of b.ops) if (!a.ops.some((x) => sameOp(x.op, o.op))) ops.push(o);
  return { attestations, ops };
}

export type Reached = { attestation: Attestation; message: Uint8Array; path: number[] };

/**
 * Every attestation with the message the operations lead to there. A branch
 * through an operation this build can't compute is left out (`skipped`).
 */
export async function attestationsOf(ts: Timestamp, message: Uint8Array): Promise<{ reached: Reached[]; skipped: number }> {
  const reached: Reached[] = [];
  let skipped = 0;
  const walk = async (t: Timestamp, msg: Uint8Array, path: number[]) => {
    for (const attestation of t.attestations) reached.push({ attestation, message: msg, path });
    for (const [i, o] of t.ops.entries()) {
      const next = await apply(o.op, msg);
      if (next === null) skipped++;
      else await walk(o.next, next, [...path, i]);
    }
  };
  await walk(ts, message, []);
  return { reached, skipped };
}

/** The timestamp at `path` (a list of op indexes), with `replace` applied there. */
export function replaceAt(ts: Timestamp, path: number[], replace: (t: Timestamp) => Timestamp): Timestamp {
  if (path.length === 0) return replace(ts);
  const [i, ...rest] = path;
  return { attestations: ts.attestations, ops: ts.ops.map((o, j) => (j === i ? { op: o.op, next: replaceAt(o.next, rest, replace) } : o)) };
}

/** A Bitcoin block's merkle root as an explorer shows it (display order) → as the proof carries it. */
export const merkleRootBytes = (displayHex: string) => fromHex(displayHex).reverse();
