import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inventories, materializeSource } from "./generate";

const root = path.resolve(import.meta.dirname, "../..");

describe("parity inventories", () => {
  it("what the software offers is what was frozen (run `pnpm parity:update` for a deliberate, explained change)", async () => {
    for (const [file, text] of Object.entries(await inventories())) {
      expect(readFileSync(path.join(root, file), "utf8"), file).toBe(text);
    }
  }, 120_000);

  it("the frozen files are canonical: no absolute path, no timestamp", () => {
    for (const f of ["trpc-procedures.json", "trpc-contract.ts", "trpc-compat.ts", "routes.json", "settings-sections.json", "i18n-keys.json"]) {
      const text = readFileSync(path.join(root, "api/parity", f), "utf8");
      expect(text, f).not.toContain(root);
      expect(text, f).not.toMatch(/\/Users\/|\/home\/|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    }
  });

  it("the frozen contract stands alone: it names nothing from the code", () => {
    const text = readFileSync(path.join(root, "api/parity/trpc-contract.ts"), "utf8");
    expect(text).not.toMatch(/^\s*import\b|\bimport\(|AppRouter|inferRouter/m);
  });
});

describe("materializing a type", () => {
  it("writes structure out in full, sorted, unions inside arrays in parentheses", () => {
    const src = `type Kind = "b" | "a"; export type T = { z: Kind[]; a?: Date; m: Map<string, number>; readonly r: readonly [number, string?] };`;
    expect(materializeSource(src, "T")).toBe('{ a?: Date | undefined; m: Map<string, number>; readonly r: readonly [number, (string | undefined)?]; z: ("a" | "b")[] }');
  });

  it("keeps readonly on properties a mapped type made so", () => {
    const src = `type Base = { a: number; b?: string }; export type T = { r: Readonly<Base>; m: { readonly [K in "x" | "y"]: number }; w: { -readonly [K in keyof Readonly<Base>]: Base[K] } };`;
    expect(materializeSource(src, "T")).toBe("{ m: { readonly x: number; readonly y: number }; r: { readonly a: number; readonly b?: string | undefined }; w: { a: number; b?: string | undefined } }");
  });

  it("names a recursive type instead of looping", () => {
    const src = `export type Node = { kind: "text"; text: string } | { kind: "list"; children: Node[] };`;
    expect(materializeSource(src, "Node")).toBe('type Rec1 = { children: Rec1[]; kind: "list" } | { kind: "text"; text: string };\nRec1');
  });

  it("numbers recursive types by where the text first names them, not by the compiler's order", () => {
    const ab = `type A = { a: A[] } | { n: 1 }; type B = { b: B[] } | { n: 2 }; export type T = { x: B; y: A };`;
    const ba = `type B = { b: B[] } | { n: 2 }; type A = { a: A[] } | { n: 1 }; export type T = { y: A; x: B };`;
    const expected = 'type Rec1 = { b: Rec1[] } | { n: 2 };\ntype Rec2 = { a: Rec2[] } | { n: 1 };\n{ x: Rec1; y: Rec2 }';
    expect(materializeSource(ab, "T")).toBe(expected);
    expect(materializeSource(ba, "T")).toBe(expected);
  });

  it("fails on what it can't write out, rather than degrading", () => {
    expect(() => materializeSource(`export type T = { x: any };`, "T")).toThrow(/T\.x: any can't be materialized/);
    expect(() => materializeSource(`export type T = { f: () => void };`, "T")).toThrow(/a function/);
    expect(() => materializeSource(`export type T = { p: Promise<number> };`, "T")).toThrow(/library type Promise/);
  });
});
