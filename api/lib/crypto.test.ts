import { describe, it, expect } from "vitest";
import { encrypt, decrypt, newSessionId, openSecret, sealSecret } from "./crypto";

describe("crypto", () => {
  it("encrypts and decrypts round-trip", () => {
    const secret = "my-jira-api-token-12345";
    const enc = encrypt(secret);
    expect(enc).not.toContain(secret);
    expect(decrypt(enc)).toBe(secret);
  });

  it("produces different ciphertexts for the same input (random IV)", () => {
    expect(encrypt("x")).not.toBe(encrypt("x"));
  });

  it("fails to decrypt tampered payloads", () => {
    const enc = encrypt("secret");
    const parts = enc.split(".");
    parts[2] = parts[2].slice(0, -2) + "AA";
    expect(() => decrypt(parts.join("."))).toThrow();
  });

  it("rejects truncated auth tags, wrong IV sizes and malformed payloads", () => {
    const [iv, tag, data] = encrypt("secret").split(".");
    const shortTag = Buffer.from(tag, "base64").subarray(0, 4).toString("base64");
    expect(() => decrypt([iv, shortTag, data].join("."))).toThrow(/auth tag/);
    const longIv = Buffer.concat([Buffer.from(iv, "base64"), Buffer.alloc(4)]).toString("base64");
    expect(() => decrypt([longIv, tag, data].join("."))).toThrow(/IV/);
    expect(() => decrypt("not-a-payload")).toThrow();
  });

  it("generates unique session ids", () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it("seals a connection's secret for that connection only, and still opens the older format", () => {
    const sealed = sealSecret("tok", 7);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("tok");
    expect(openSecret(sealed, 7)).toEqual({ plain: "tok", fresh: true });
    // Copied onto another connection, it doesn't open.
    expect(() => openSecret(sealed, 8)).toThrow(/can't be opened/);
    // The older format (session-derived key, no binding) opens, and asks to be sealed again.
    expect(openSecret(encrypt("old"), 7)).toEqual({ plain: "old", fresh: false });
  });
});
