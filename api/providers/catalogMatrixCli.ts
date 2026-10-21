// Rewrites the capability matrix of api/providers/CATALOG.md from the code.
import { readFileSync, writeFileSync } from "node:fs";
import { withMatrix } from "./catalogMatrix";

const path = new URL("./CATALOG.md", import.meta.url);
writeFileSync(path, withMatrix(readFileSync(path, "utf8")));
console.log("CATALOG.md matrix written");
