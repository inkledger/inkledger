// Signed links to an attachment, for an agent (docs/work/ideas/issue-copy.md R-6.4, R-6.7).
import { afterEach, describe, expect, it } from "vitest";
import { env } from "./env";
import { signShare, verifyShare, SHARE_MAX_MS } from "./shareLinks";

const saved = { key: env.credentialsKey, old: env.credentialsKeyOld };
afterEach(() => {
  env.credentialsKey = saved.key;
  env.credentialsKeyOld = saved.old;
});

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const base = { u: 1, c: 2, a: "77", iat: NOW, exp: NOW + HOUR, g: 0 };

describe("share links", () => {
  it("a share link holds only while signed, fresh and short", () => {
    const token = signShare(base);
    expect(verifyShare(token, NOW + HOUR - 1)).toEqual({ v: 1, ...base });
    // Expired.
    expect(verifyShare(token, NOW + HOUR + 1)).toBeNull();
    // Tampered payload or signature.
    const [payload, sig] = token.split(".");
    const other = Buffer.from(JSON.stringify({ v: 1, ...base, a: "78" })).toString("base64url");
    expect(verifyShare(`${other}.${sig}`, NOW)).toBeNull();
    expect(verifyShare(`${payload}.${sig.slice(0, -2)}AA`, NOW)).toBeNull();
    expect(verifyShare("garbage", NOW)).toBeNull();
    expect(verifyShare(`${payload}`, NOW)).toBeNull();
    // Longer than 24 h: refused when signing and when reading.
    expect(() => signShare({ ...base, exp: NOW + SHARE_MAX_MS + 1 })).toThrow();
    // A key rotated since (CREDENTIALS_KEY_OLD = the former one): still opens.
    env.credentialsKey = "a".repeat(64);
    const rotated = signShare(base);
    env.credentialsKeyOld = env.credentialsKey;
    env.credentialsKey = "b".repeat(64);
    expect(verifyShare(rotated, NOW)?.a).toBe("77");
    // An unknown key: no.
    env.credentialsKeyOld = null;
    expect(verifyShare(rotated, NOW)).toBeNull();
  });
});
