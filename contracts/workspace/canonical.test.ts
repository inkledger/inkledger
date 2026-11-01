import { describe, expect, it } from "vitest";
import { fingerprint as nodeFingerprint } from "../../api/workspace/crypto";
import { fingerprint as browserFingerprint } from "../../src/lib/workspace/crypto";
import { canonicalBytes, canonicalJSON, domainSeparatedBytes, sortByStableId } from "./canonical";

const vector = {
  z: "e\u0301",
  a: [3, 2, 1],
  nested: { b: true, a: null },
};

describe("workspace canonicalization", () => {
  it("sorts object keys and normalizes strings without changing semantic array order", () => {
    expect(canonicalJSON(vector)).toBe('{"a":[3,2,1],"nested":{"a":null,"b":true},"z":"é"}');
    expect(canonicalJSON({ a: undefined })).toBe("{}");
    expect([...canonicalBytes("é")]).toEqual([...new TextEncoder().encode(canonicalJSON("é"))]);
    expect(new TextDecoder().decode(domainSeparatedBytes("test", { a: 1 }))).toBe('inkledger-workspace-test-v1\n{"a":1}');
  });

  it("rejects non-canonical values instead of producing ambiguous bytes", () => {
    for (const value of [1.5, NaN, Infinity, 2 ** 53, 1n, () => 1, new Date(), [undefined]]) {
      expect(() => canonicalJSON(value)).toThrow("workspace canon v1");
    }
  });

  it("sorts only explicitly unordered collections by stable id", () => {
    expect(sortByStableId([{ id: "b" }, { id: "a" }], item => item.id).map(item => item.id)).toEqual(["a", "b"]);
    expect(() => sortByStableId([{ id: "a" }, { id: "a" }], item => item.id)).toThrow("duplicate stable id");
  });
});

describe("workspace fingerprint adapters", () => {
  it("Node and WebCrypto return the same full SHA-256 and version metadata", async () => {
    const node = nodeFingerprint("workspace", vector);
    const browser = await browserFingerprint("workspace", vector);
    expect(browser).toEqual(node);
    expect(node.value).toMatch(/^[0-9a-f]{64}$/);
    expect(node.canonicalizationVersion).toBe(1);
    expect(node.fieldsVersion).toBe(1);
    expect(node.fingerprintAlgorithm).toBe("SHA-256");
  });

  it("domain separation and collection ordering are explicit", async () => {
    expect(nodeFingerprint("input", vector).value).not.toBe(nodeFingerprint("workspace", vector).value);
    expect(nodeFingerprint("workspace", { anchors: [{ id: "b" }, { id: "a" }] }).value).not.toBe(
      nodeFingerprint("workspace", { anchors: [{ id: "a" }, { id: "b" }] }).value,
    );
    const sorted = sortByStableId([{ id: "b" }, { id: "a" }], item => item.id);
    expect((await browserFingerprint("workspace", sorted)).value).toBe(nodeFingerprint("workspace", sorted).value);
  });

  it("normalizes keys before ordering them and refuses keys that collide after NFC", () => {
    expect(canonicalJSON({ "\u00e9": 1, f: 2 })).toBe(canonicalJSON({ f: 2, "e\u0301": 1 }));
    expect(canonicalJSON({ "e\u0301": 1, f: 2 })).toBe('{"f":2,"\u00e9":1}');
    expect(() => canonicalJSON({ "\u00e9": 1, "e\u0301": 2 })).toThrow(/NFC/);
  });
});
