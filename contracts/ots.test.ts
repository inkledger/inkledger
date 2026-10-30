// The .ots reader (contracts/ots.ts) on the official example (opentimestamps-client examples/hello-world.txt.ots):
// read and written back byte for byte, and its operations lead to the merkle root of Bitcoin block 358391
// as an explorer shows it. The store Worker runs the same code (inkledger-modules store/src/ots.ts).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { attestationsOf, mergeTimestamps, merkleRootBytes, OtsError, parseProof, parseTimestamp, ripemd160, serializeProof, serializeTimestamp, toHex, type Timestamp } from "./ots";

const OTS = new Uint8Array(readFileSync(new URL("./__fixtures__/hello-world.txt.ots", import.meta.url)));
const TEXT = readFileSync(new URL("./__fixtures__/hello-world.txt", import.meta.url));

describe("ots", () => {
  it("the official example proof reaches its Bitcoin block", async () => {
    const proof = parseProof(OTS);
    expect(toHex(proof.digest)).toBe(createHash("sha256").update(TEXT).digest("hex"));
    expect(serializeProof(proof)).toEqual(OTS);
    const { reached, skipped } = await attestationsOf(proof.timestamp, proof.digest);
    expect(skipped).toBe(0);
    expect(reached.map(r => r.attestation)).toEqual([{ kind: "bitcoin", height: 358391 }]);
    expect(toHex(reached[0].message)).toBe(toHex(merkleRootBytes("8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00")));
  });

  it("RIPEMD-160 follows its test vectors", () => {
    const e = new TextEncoder();
    expect(toHex(ripemd160(new Uint8Array()))).toBe("9c1185a5c5e9fc54612808977ee8f548b2258d31");
    expect(toHex(ripemd160(e.encode("abc")))).toBe("8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
    expect(toHex(ripemd160(e.encode("message digest")))).toBe("5d0689ef49d2fae572b881b123a85ffa21595f36");
    expect(toHex(ripemd160(e.encode("a".repeat(1_000_000))))).toBe("52783243c1697bdbe16d37f97f68f08325dc1528");
  });

  it("two calendars' answers merge into one proof, read back the same", async () => {
    const pending = (uri: string, nonce: number): Timestamp => ({
      attestations: [],
      ops: [{ op: { name: "append", arg: new Uint8Array([nonce]) }, next: { attestations: [], ops: [{ op: { name: "sha256" }, next: { attestations: [{ kind: "pending", uri }], ops: [] } }] } }],
    });
    const merged = mergeTimestamps(pending("https://a.example", 1), pending("https://b.example", 2));
    const digest = new Uint8Array(32).fill(7);
    const back = parseProof(serializeProof({ digest, timestamp: merged }));
    const uris = (await attestationsOf(back.timestamp, digest)).reached.map(r => (r.attestation.kind === "pending" ? r.attestation.uri : ""));
    expect(uris.sort()).toEqual(["https://a.example", "https://b.example"]);
    expect(parseTimestamp(serializeTimestamp(merged))).toEqual(back.timestamp);
    // Not a proof, or cut short: refused, never half read.
    expect(() => parseProof(new Uint8Array([1, 2, 3]))).toThrow(OtsError);
    expect(() => parseProof(OTS.subarray(0, OTS.length - 5))).toThrow(OtsError);
  });
});
