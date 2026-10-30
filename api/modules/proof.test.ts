// A licence's timestamp on Bitcoin, verified here (docs/work/ideas/onchain-licences.md R-4.6): the proof from
// the store, kept on the server, checked with our own reader against an explorer. The official OpenTimestamps
// example stands in for a licence: its text is the "licence", its proof the store's.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL = ":memory:";

const TEXT = readFileSync(new URL("../../contracts/__fixtures__/hello-world.txt", import.meta.url), "utf8");
const OTS = readFileSync(new URL("../../contracts/__fixtures__/hello-world.txt.ots", import.meta.url));
const BLOCK = { height: 358391, hash: "000000000000000003e892881a8cdcdc117c06d444057c98b6f04a9ee75a2319", merkle_root: "8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00", timestamp: 1432827678 };

const net = { store: true, explorer: true, backfilled: false };
// Not in a block yet: the licence's digest, then only a calendar's promise.
const { serializeProof } = await import("@contracts/ots");
const { createHash } = await import("node:crypto");
const PENDING = Buffer.from(
  serializeProof({
    digest: new Uint8Array(createHash("sha256").update(TEXT, "utf8").digest()),
    timestamp: { attestations: [], ops: [{ op: { name: "sha256" }, next: { attestations: [{ kind: "pending", uri: "https://a.pool.opentimestamps.org" }], ops: [] } }] },
  }),
).toString("base64");
afterEach(() => Object.assign(net, { store: true, explorer: true, backfilled: false }));

const { env } = await import("../lib/env");

describe("licence proofs", () => {
  beforeAll(async () => {
    env.storeUrl = "https://store.test";
    env.otsExplorer = "https://explorer.test/api";
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.origin === "https://store.test") {
        if (!net.store) throw new TypeError("offline");
        if (url.pathname === "/ots/LIC-1") return Response.json({ status: "complete", block: BLOCK.height, ots: OTS.toString("base64"), backfilled: net.backfilled });
        if (url.pathname === "/ots/LIC-2") return Response.json({ status: "pending", block: null, ots: PENDING, backfilled: false });
        return Response.json({ error: "unknown" }, { status: 404 });
      }
      if (url.origin === "https://explorer.test") {
        if (!net.explorer) throw new TypeError("offline");
        if (url.pathname === `/api/block-height/${BLOCK.height}`) return new Response(BLOCK.hash);
        if (url.pathname === `/api/block/${BLOCK.hash}`) return Response.json({ id: BLOCK.hash, height: BLOCK.height, merkle_root: BLOCK.merkle_root, timestamp: BLOCK.timestamp });
        return new Response("not found", { status: 404 });
      }
      throw new Error(`unexpected ${url.href}`);
    });
    await (await import("../queries/connection")).resetDbForTests();
  });

  it("a proof verifies against Bitcoin, offline stays unverified", async () => {
    const { proofOf } = await import("./proof");
    // Its digest, its operations and the block's merkle root agree: on Bitcoin since that block's time.
    expect(await proofOf("LIC-1", TEXT)).toEqual({ status: "verified", block: BLOCK.height, time: BLOCK.timestamp * 1000, existedBy: false });
    // The explorer out of reach: kept as it was, never "failed".
    net.explorer = false;
    expect(await proofOf("LIC-1", TEXT)).toMatchObject({ status: "unverified", block: BLOCK.height });
    // The store out of reach too: the proof kept on the server still says what it can.
    net.store = false;
    expect(await proofOf("LIC-1", TEXT)).toMatchObject({ status: "unverified", block: BLOCK.height });
    net.store = true;
    net.explorer = true;
    // Another licence text under the same id: the proof doesn't match it.
    expect(await proofOf("LIC-1", `${TEXT} `)).toMatchObject({ status: "failed" });
    // Not in a block yet; not stamped at all; stamped after it was issued.
    expect(await proofOf("LIC-2", TEXT)).toMatchObject({ status: "pending", block: null });
    expect(await proofOf("LIC-3", TEXT)).toEqual({ status: "none", block: null, time: null, existedBy: false });
    net.backfilled = true;
    expect(await proofOf("LIC-1", TEXT)).toMatchObject({ status: "verified", existedBy: true });
    // The .ots, to check it with any OpenTimestamps tool.
    const { proofFile } = await import("./proof");
    expect(await proofFile("LIC-1")).toEqual({ filename: "LIC-1.ots", base64: OTS.toString("base64") });
    expect(await proofFile("LIC-3")).toBeNull();
  });
});
