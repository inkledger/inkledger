import { describe, expect, it } from "vitest";
import { hashPassword, temporaryPassword, verifyPassword } from "./password";

describe("passwords", () => {
  it("verify only the password they were made from", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
  });

  it("never match a malformed or tampered hash", async () => {
    const hash = await hashPassword("pw-123456789012");
    expect(await verifyPassword("pw-123456789012", "plain")).toBe(false);
    expect(await verifyPassword("pw-123456789012", hash.replace("$32768$", "$99999999$"))).toBe(false);
    expect(await verifyPassword("pw-123456789012", hash.slice(0, -4))).toBe(false);
  });

  it("are salted, and temporary ones are long and distinct", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
    const a = temporaryPassword();
    expect(a).toHaveLength(16);
    expect(temporaryPassword()).not.toBe(a);
  });
});
