import { describe, expect, it } from "vitest";
import { storeItemSchema } from "@contracts/storeSchema";

const item = (requires: unknown) => ({
  id: "bonsai",
  product: "inkledger.bonsai",
  version: "1.0.0",
  hostApi: { min: 1, max: 1 },
  name: { en: "Bonsai", it: "Bonsai" },
  tagline: { en: "t", it: "t" },
  mode: "request",
  requires,
});

describe("store requirements", () => {
  it("keeps the known ones and drops what this inkledger can't check", () => {
    expect(storeItemSchema.parse(item(["webgl2", "quantum"])).requires).toEqual(["webgl2"]);
    expect(storeItemSchema.parse(item(undefined)).requires).toBeUndefined();
    expect(storeItemSchema.parse(item("webgl2")).requires).toBeUndefined();
  });
});
