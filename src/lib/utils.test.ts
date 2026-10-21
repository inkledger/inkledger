import { describe, it, expect } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("keeps custom font sizes next to text colours", () => {
    expect(cn("text-overline text-muted-foreground")).toBe(
      "text-overline text-muted-foreground"
    );
    expect(cn("text-title", "text-heading")).toBe("text-heading");
  });
});
