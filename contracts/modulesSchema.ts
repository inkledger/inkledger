import { z } from "zod";
import { SLOT_IDS } from "./modules";

export const moduleIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

/** The signed manifest: closed, every field checked before anything loads. */
export const moduleManifestSchema = z.strictObject({
  id: moduleIdSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** "inkledger.<id>": what a licence unlocks. */
  product: z.string().regex(/^inkledger\.[a-z0-9-]+$/),
  /** The ES module to import (a declared .js / .mjs file). */
  entry: z.string().regex(/^[\w./-]+\.m?js$/),
  hostApi: z.strictObject({ min: z.number().int().positive(), max: z.number().int().positive() }),
  slots: z.array(z.enum(SLOT_IDS)).min(1),
  /** Display name, by locale. */
  name: z.strictObject({ en: z.string().min(1).max(40), it: z.string().min(1).max(40) }),
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

/** A licence payload (inside the signed envelope). Extra fields are ignored. */
export const licensePayloadSchema = z.object({
  id: z.string().min(1).max(64),
  email_hash: z.string().min(1),
  product: z.string().min(1),
  /** Epoch ms */
  issued: z.number().int().nonnegative(),
  v: z.number().int().positive(),
});
export type LicensePayload = z.infer<typeof licensePayloadSchema>;
