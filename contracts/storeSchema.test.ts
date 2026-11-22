import { describe, expect, it } from "vitest";
import { storeItemSchema } from "./storeSchema";

describe("a Store item", () => {
  it("links its docs on the web only", () => {
    const docs = (docsUrl: string) => storeItemSchema.shape.docsUrl.parse(docsUrl) !== undefined;
    expect(docs("https://docs.example.com/mod")).toBe(true);
    expect(docs("javascript:alert(1)")).toBe(false);
    expect(docs("file:///etc/passwd")).toBe(false);
  });

  it("a link off the web drops the link, not the item (the Store would hide a product its owners have)", () => {
    const item = storeItemSchema.shape.docsUrl.parse("mailto:help@example.com");
    expect(item).toBeUndefined();
  });
});
