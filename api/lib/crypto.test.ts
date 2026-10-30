import { describe, it, expect } from "vitest";
import { encrypt, decrypt, newSessionId, openBytesFor, openSecret, sealBytesFor, sealSecret } from "./crypto";
import { env } from "./env";

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

  it("a sealed copy opens only for its own mail", () => {
    const plain = Buffer.from("From: a@b.c\r\nSubject: Hi\r\n\r\nbody \u00e8", "utf8");
    const sealed = sealBytesFor(plain, "mailcopy:7:41");
    expect(sealed[0]).toBe(1);
    expect(sealed.includes(plain)).toBe(false);
    expect(openBytesFor(sealed, "mailcopy:7:41").equals(plain)).toBe(true);
    // The same bytes moved to another mail, or another user: they don't open.
    expect(() => openBytesFor(sealed, "mailcopy:7:42")).toThrow();
    expect(() => openBytesFor(sealed, "mailcopy:8:41")).toThrow();
    // Tampered or cut short: no.
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1] ^= 1;
    expect(() => openBytesFor(flipped, "mailcopy:7:41")).toThrow();
    expect(() => openBytesFor(sealed.subarray(0, 20), "mailcopy:7:41")).toThrow();
  });

  it("bytes sealed with the old key still open", () => {
    const saved = { key: env.credentialsKey, old: env.credentialsKeyOld };
    try {
      env.credentialsKey = "c".repeat(64);
      const sealed = sealBytesFor(Buffer.from("copy"), "mailcopy:1:1");
      env.credentialsKeyOld = env.credentialsKey;
      env.credentialsKey = "d".repeat(64);
      expect(openBytesFor(sealed, "mailcopy:1:1").toString()).toBe("copy");
      env.credentialsKeyOld = null;
      expect(() => openBytesFor(sealed, "mailcopy:1:1")).toThrow();
    } finally {
      env.credentialsKey = saved.key;
      env.credentialsKeyOld = saved.old;
    }
  });
});
