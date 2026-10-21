import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { withMatrix } from "./catalogMatrix";

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");

describe("CATALOG.md", () => {
  it("shows the capability matrix the code declares (run `pnpm catalog:matrix` after a catalogue change)", () => {
    const doc = read("api/providers/CATALOG.md");
    expect(doc).toBe(withMatrix(doc));
  });

  it("every value still to verify points to a spike", () => {
    // The catalogue's own values and each built adapter's declaration.
    const adapters = readdirSync(path.resolve(process.cwd(), "api/providers"))
      .map((d) => `api/providers/${d}/adapter.ts`)
      .filter((f) => existsSync(path.resolve(process.cwd(), f)));
    const marked = ["api/providers/catalog.ts", ...adapters].flatMap((f) => [...read(f).matchAll(/\(verify: ([a-z0-9-]+)\)/g)].map((m) => m[1]));
    expect(marked.length).toBeGreaterThan(0);
    const spikes = read("docs/dev/spikes.md");
    for (const id of marked) expect(spikes, id).toContain(`| ${id} |`);
  });
});
