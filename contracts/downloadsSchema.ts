import { z } from "zod";

/** One published app build (written by scripts/native-publish.mjs). */
export const appBuildSchema = z.object({
  version: z.string().min(1),
  /** File name inside the downloads folder (e.g. "inkledger.apk"). */
  file: z.string().regex(/^[\w.-]+\.apk$/),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Epoch ms */
  builtAt: z.number().int().nonnegative(),
});
export type AppBuild = z.infer<typeof appBuildSchema>;

export const downloadsManifestSchema = z.object({
  android: appBuildSchema.nullable(),
});
export type DownloadsManifest = z.infer<typeof downloadsManifestSchema>;
