import { randomBytes } from "node:crypto";
import { sha256Hex } from "../lib/hash";
import { APPLY_POLICY_V1 } from "@contracts/workspace/versions";

export function newActivationToken(): string {
  return randomBytes(APPLY_POLICY_V1.tokenBytes).toString("base64url");
}

export function hashActivationToken(token: string): string {
  return sha256Hex(token);
}
