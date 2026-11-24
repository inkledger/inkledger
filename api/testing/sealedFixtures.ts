import { createCipheriv, createHash, randomBytes } from "node:crypto";

/** Fixtures sealed the way the app seals them, with any key: what an older key left in the database. */
export const hexKey = () => randomBytes(32).toString("hex");
export const fromHex = (hex: string) => Buffer.from(hex, "hex");
export const fromSecret = (secret: string) => createHash("sha256").update(secret).digest();

function gcm(key: Buffer, plain: Buffer, aad: string | null) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  if (aad !== null) c.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([c.update(plain), c.final()]);
  return { iv, tag: c.getAuthTag(), data };
}

/** sealSecret / sealFor: "v1." and the scope as AAD (`connection:<id>` for a connection). */
export function sealedText(key: Buffer, plain: string, scope: string): string {
  const { iv, tag, data } = gcm(key, Buffer.from(plain, "utf8"), scope);
  return "v1." + [iv, tag, data].map((b) => b.toString("base64")).join(".");
}

/** The older connection format: no prefix, no binding. */
export function legacyText(key: Buffer, plain: string): string {
  const { iv, tag, data } = gcm(key, Buffer.from(plain, "utf8"), null);
  return [iv, tag, data].map((b) => b.toString("base64")).join(".");
}

/** sealBytesFor: 0x01 | iv | tag | data. */
export function sealedBytes(key: Buffer, plain: Buffer, scope: string): Buffer {
  const { iv, tag, data } = gcm(key, plain, scope);
  return Buffer.concat([Buffer.from([1]), iv, tag, data]);
}
