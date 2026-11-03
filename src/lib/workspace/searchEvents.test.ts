import { describe, expect, it } from "vitest";
import { routeControlId } from "./searchEvents";

describe("the sidebar entry a page stands for", () => {
  it("is the Issues list for the list alone, never for an issue opened from search", () => {
    expect(routeControlId("/issues")).toBe("shell.nav.issues");
    expect(routeControlId("/issues?favorites")).toBe("shell.nav.issues");
    expect(routeControlId("/issues/1/APP-214")).toBeUndefined();
    expect(routeControlId("/issues/APP-214")).toBeUndefined();
  });

  it("names the Desk and Team time like every other entry", () => {
    expect(routeControlId("/issues/desk")).toBe("shell.nav.desk");
    expect(routeControlId("/team")).toBe("shell.nav.team");
  });
});
