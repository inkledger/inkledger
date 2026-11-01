import { createHash, randomBytes } from "node:crypto";
import { APPLY_POLICY_V1 } from "@contracts/workspace/versions";

export function newActivationToken(): string {
  return randomBytes(APPLY_POLICY_V1.tokenBytes).toString("base64url");
}

export function hashActivationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
