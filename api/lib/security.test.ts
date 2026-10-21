import { describe, it, expect } from "vitest";
import {
  assertSafeJiraUrl,
  createRateLimiter,
  hashSessionId,
  isAllowedHost,
  isForbiddenAddress,
  isReservedHost,
  assertSafeUrl,
  UnsafeUrlError,
} from "./security";
import { parseCookies } from "../context";

const resolveTo = (...ips: string[]) => async () => ips;

describe("isForbiddenAddress", () => {
  it.each(["127.0.0.1", "0.0.0.0", "169.254.169.254", "::1", "::", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"])(
    "blocks %s",
    (ip) => expect(isForbiddenAddress(ip)).toBe(true),
  );

  it.each(["10.39.201.91", "192.168.1.10", "172.16.0.5", "203.0.113.10", "2001:db8::1"])(
    "allows %s (on-prem Jira lives on private ranges)",
    (ip) => expect(isForbiddenAddress(ip)).toBe(false),
  );
  it.each(["10.39.201.91", "192.168.1.10", "172.16.0.5", "100.101.102.103", "fd12::1", "::ffff:10.0.0.1"])(
    "keeps a service on the internet off %s (private ranges are for self-hosted trackers)",
    (ip) => expect(isForbiddenAddress(ip, "public")).toBe(true),
  );

  it.each(["localhost", "db", "inkledger-db", "app.localhost", "DB."])("never calls the server's own neighbour %s", async (host) => {
    expect(isReservedHost(host)).toBe(true);
    await expect(assertSafeUrl(`http://${host}/`, { resolve: resolveTo("10.0.0.2") })).rejects.toThrow(UnsafeUrlError);
  });
});

describe("assertSafeJiraUrl", () => {
  it("accepts a public https host", async () => {
    await expect(
      assertSafeJiraUrl("https://acme.atlassian.net", [], resolveTo("203.0.113.10")),
    ).resolves.toBeUndefined();
  });

  it("rejects non-http schemes and embedded credentials", async () => {
    await expect(assertSafeJiraUrl("file:///etc/passwd", [], resolveTo())).rejects.toThrow();
    await expect(
      assertSafeJiraUrl("https://u:p@acme.atlassian.net", [], resolveTo("203.0.113.10")),
    ).rejects.toThrow(/credentials/);
  });

  it("rejects hosts resolving to loopback or metadata addresses", async () => {
    await expect(
      assertSafeJiraUrl("https://evil.example", [], resolveTo("203.0.113.10", "127.0.0.1")),
    ).rejects.toThrow(/is not allowed/);
    await expect(assertSafeJiraUrl("http://169.254.169.254", [], resolveTo())).rejects.toThrow();
  });

  it("enforces the allowlist when configured", async () => {
    await expect(
      assertSafeJiraUrl("https://other.example", ["jira.acme.it"], resolveTo("203.0.113.10")),
    ).rejects.toThrow(/is not allowed/);
    await expect(
      assertSafeJiraUrl("https://JIRA.acme.it", ["jira.acme.it"], resolveTo("10.0.0.5")),
    ).resolves.toBeUndefined();
  });
});

describe("createRateLimiter", () => {
  it("blocks after the limit within the window and resets after it", () => {
    const rl = createRateLimiter(2, 1000);
    expect(rl.hit("k", 0)).toBe(0);
    expect(rl.hit("k", 10)).toBe(0);
    expect(rl.hit("k", 20)).toBeGreaterThan(0);
    expect(rl.hit("k", 1001)).toBe(0);
  });

  it("reset clears the counter", () => {
    const rl = createRateLimiter(1, 1000);
    rl.hit("k", 0);
    rl.reset("k");
    expect(rl.hit("k", 1)).toBe(0);
  });
});

describe("sessions", () => {
  it("hashes session ids deterministically", () => {
    expect(hashSessionId("abc")).toBe(hashSessionId("abc"));
    expect(hashSessionId("abc")).not.toContain("abc");
  });

  it("parseCookies tolerates malformed percent-encoding", () => {
    expect(parseCookies("a=%E0%A4%A; b=ok")).toEqual({ a: "%E0%A4%A", b: "ok" });
  });
});

describe("isAllowedHost", () => {
  const loopback = ["localhost", "127.0.0.1", "::1"];

  it("accepts loopback names with or without a port", () => {
    for (const h of ["localhost:47823", "127.0.0.1:47823", "[::1]:47823", "LOCALHOST"]) {
      expect(isAllowedHost(h, loopback), h).toBe(true);
    }
  });

  it("refuses rebound or missing hosts", () => {
    for (const h of ["evil.example", "evil.example:47823", "localhost.evil.example", "", undefined]) {
      expect(isAllowedHost(h, loopback), String(h)).toBe(false);
    }
  });

  it("allows anything when the list is empty", () => {
    expect(isAllowedHost("evil.example", [])).toBe(true);
    expect(isAllowedHost(undefined, [])).toBe(true);
  });
});
