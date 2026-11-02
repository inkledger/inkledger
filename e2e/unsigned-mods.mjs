// The real modules as built unsigned by inkledger-modules' `pnpm build:unsigned`, signed here
// with a throwaway key and fixture licences (never a real key) for the real loader. Shared by
// e2e/mods-real.test.mjs and scripts/lighthouse.mjs.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signEnvelope } from "../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../api/vendor/seal/package.ts";

/** The module ids in an unsigned build folder. */
export const unsignedIds = build => readdirSync(build).filter(id => existsSync(join(build, id, "manifest.unsigned.json")));

/**
 * Installs `ids` from `build` (metadata from its sibling `packages/`) into a new temporary
 * modules folder `dir`, signed with a throwaway key. `env` makes the server trust that key;
 * `licenses` go in the 'modules.licenses' server setting. Remove `join(dir, "..")` when done.
 */
export function signedMods(build, ids, prefix) {
  const key = generateKeyPairSync("ed25519");
  const dir = join(mkdtempSync(join(tmpdir(), prefix)), "modules");
  for (const id of ids) {
    const meta = JSON.parse(readFileSync(join(build, "..", "packages", id, "meta.json"), "utf8"));
    const out = join(dir, id);
    mkdirSync(out, { recursive: true });
    const files = {};
    for (const f of readdirSync(join(build, id)).filter(f => f !== "manifest.unsigned.json")) {
      const bytes = readFileSync(join(build, id, f));
      writeFileSync(join(out, f), bytes);
      files[f] = sha256hex(bytes);
    }
    const manifest = { ...meta, files };
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(out, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", key.privateKey));
  }
  const license = id =>
    signEnvelope(Buffer.from(JSON.stringify({ id: `L-${id}`, email_hash: "h", product: `inkledger.${id}`, issued: 1, v: 1 })), "inkledger-license-v1\n", key.privateKey);
  return {
    dir,
    env: { MODULES_DIR: dir, MODULES_TRUST_EXTRA_KEY: key.publicKey.export({ type: "spki", format: "pem" }).toString(), MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" },
    licenses: ids.map(license),
  };
}
