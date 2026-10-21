// `pnpm parity:update`: writes the parity inventories (see generate.ts).
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inventories } from "./generate";

const root = path.resolve(import.meta.dirname, "../..");
for (const [file, text] of Object.entries(await inventories())) {
  writeFileSync(path.join(root, file), text);
  console.log(`wrote ${file}`);
}
process.exit(0);
