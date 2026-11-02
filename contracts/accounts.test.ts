import { describe, expect, it } from "vitest";
import { DEFAULT_PERMISSIONS } from "./accounts";

describe("accounts", () => {
  it("a new account gets no power and no add-on modules unless the admin gives them", () => {
    expect(DEFAULT_PERMISSIONS).toEqual([]);
  });
});
