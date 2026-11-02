import { createHash } from "node:crypto";

/** SHA-256 of a text (UTF-8) or bytes, as lowercase hex. */
export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
