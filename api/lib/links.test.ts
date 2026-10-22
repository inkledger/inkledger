import { describe, expect, it } from "vitest";
import { domainInput } from "@contracts/linksSchema";
import { hostAllowed, normalizeDomain, safeExternalUrl } from "@contracts/links";

describe("external link domains", () => {
  it("normalizes what people paste", () => {
    expect(normalizeDomain("https://Drive.Google.com/file/d/1")).toBe("drive.google.com");
    expect(normalizeDomain("*.atlassian.net")).toBe("atlassian.net");
    expect(normalizeDomain("example.it:8443/")).toBe("example.it");
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(domainInput.safeParse("javascript:alert(1)").success).toBe(false);
  });

  it("a domain allows itself and its subdomains", () => {
    expect(hostAllowed("drive.google.com", ["google.com"])).toBe(true);
    expect(hostAllowed("google.com", ["google.com"])).toBe(true);
    expect(hostAllowed("evilgoogle.com", ["google.com"])).toBe(false);
    expect(hostAllowed("google.com.evil.io", ["google.com"])).toBe(false);
  });

  it("only web and mail links open", () => {
    expect(safeExternalUrl("https://x.it/a")?.hostname).toBe("x.it");
    expect(safeExternalUrl("mailto:a@b.it")).not.toBeNull();
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("data:text/html,x")).toBeNull();
  });
});
