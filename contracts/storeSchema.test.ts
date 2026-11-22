import { describe, expect, it } from "vitest";
import { storeItemSchema } from "./storeSchema";

describe("a Store item", () => {
  it("links its docs on the web only", () => {
    const docs = (docsUrl: string) => storeItemSchema.shape.docsUrl.safeParse(docsUrl).success;
    expect(docs("https://docs.example.com/mod")).toBe(true);
    expect(docs("javascript:alert(1)")).toBe(false);
    expect(docs("file:///etc/passwd")).toBe(false);
  });
});
