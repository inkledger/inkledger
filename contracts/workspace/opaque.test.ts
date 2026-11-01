import { describe, expect, it } from "vitest";
import { createOpaqueEntry as createNodeEntry, verifyOpaqueEntry as verifyNodeEntry } from "../../api/workspace/crypto";
import { createOpaqueEntry as createBrowserEntry, verifyOpaqueEntry as verifyBrowserEntry } from "../../src/lib/workspace/crypto";
import {
  assertOpaqueEntries,
  assertWritableDocument,
  base64UrlToBytes,
  bytesToBase64Url,
  opaqueDocument,
} from "./opaque";

describe("opaque forward-compatible entries", () => {
  it("preserves arbitrary payload bytes with the same digest in Node and WebCrypto", async () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const node = createNodeEntry("future.anchor", 7, bytes);
    const browser = await createBrowserEntry("future.anchor", 7, bytes);
    expect(browser).toEqual(node);
    expect([...base64UrlToBytes(node.payloadBase64url)]).toEqual([...bytes]);
    expect(verifyNodeEntry(node)).toBe(true);
    expect(await verifyBrowserEntry(browser)).toBe(true);
    expect(bytesToBase64Url(base64UrlToBytes(node.payloadBase64url))).toBe(node.payloadBase64url);
  });

  it("round-trips known and unknown content but makes unknown content read-only", () => {
    const entry = createNodeEntry("future.area", 2, new TextEncoder().encode('{"future":true}'));
    const document = opaqueDocument({ visible: ["dashboard.timeline"] }, [entry]);
    expect(document.unknownContent).toBe(true);
    expect(() => assertWritableDocument(document)).toThrow("read-only");
    expect(() => assertOpaqueEntries(document.opaque)).not.toThrow();
    expect(opaqueDocument({ visible: [] }, []).unknownContent).toBe(false);
  });

  it("rejects malformed, oversized and duplicate entries", () => {
    const entry = createNodeEntry("future.control", 1, Uint8Array.from([1]));
    expect(() => assertOpaqueEntries([entry, entry])).toThrow("duplicate entry");
    expect(() => assertOpaqueEntries([{ ...entry, byteLength: 2 }])).toThrow("byte length mismatch");
    expect(() => assertOpaqueEntries([{ ...entry, sha256: "0".repeat(64) }])).not.toThrow();
    expect(() => base64UrlToBytes("a")).toThrow("invalid base64url");
    expect(() => createNodeEntry("future.large", 1, new Uint8Array(16 * 1024 + 1))).toThrow("entry too large");
    expect(() => assertOpaqueEntries(Array.from({ length: 33 }, (_, index) => createNodeEntry(`future.${index}`, 1, Uint8Array.from([index]))))).toThrow("too many entries");
  });
});
