import { describe, expect, it } from "vitest";
import { tidyMissing } from "./noteTidy";

describe("tidyMissing: what the model's copy lost", () => {
  it("keys, links and numbers of the original that the copy no longer has", () => {
    const original = "call w/ Rossi re APP-12, budget 1.500 eur, see https://x.it/a and 3 mails at 14:30";
    expect(tidyMissing(original, "Call with Rossi about APP-12: a budget of 1.500 EUR (https://x.it/a), 3 mails, 14:30.")).toEqual([]);
    expect(tidyMissing(original, "Call with Rossi about the budget.")).toEqual(["APP-12", "https://x.it/a", "1.500", "3", "14:30"]);
  });
});
