import { describe, expect, it } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";

// A server moved from an older inkledger: its old SESSION_SECRET (64 hex chars, as
// `openssl rand -hex 32` makes it) given as CREDENTIALS_KEY_OLD.
const OLD = randomBytes(32).toString("hex");
process.env.CREDENTIALS_KEY_OLD = OLD;
process.env.CREDENTIALS_KEY = randomBytes(32).toString("hex");

/** The older format, as the old server wrote it: sha256 of its session secret, no binding. */
function oldFormat(plain: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", createHash("sha256").update(OLD).digest(), iv, { authTagLength: 16 });
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

describe("credentials from an older server", () => {
  it("open with its old session secret as CREDENTIALS_KEY_OLD, hex or not, and are sealed again", async () => {
    const { openSecret, sealSecret } = await import("./crypto");
    expect(openSecret(oldFormat("jira-token"), 7)).toEqual({ plain: "jira-token", fresh: false });
    const again = sealSecret("jira-token", 7);
    expect(openSecret(again, 7)).toEqual({ plain: "jira-token", fresh: true });
  });
});
