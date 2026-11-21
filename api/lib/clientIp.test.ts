import { afterEach, describe, expect, it } from "vitest";
import { addressKey, clientIp } from "./session";

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

describe("the client address the limits count", () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });

  it("is the socket's without a trusted proxy, whatever X-Forwarded-For says", () => {
    expect(clientIp(req("http://localhost/", { "x-forwarded-for": "203.0.113.9" }), "198.51.100.7")).toBe("198.51.100.7");
  });

  it("behind a proxy (TRUST_PROXY=1), the entry that proxy added: the last, not the first the client wrote", () => {
    process.env.TRUST_PROXY = "1";
    const xff = { "x-forwarded-for": "1.2.3.4, 203.0.113.5" };
    expect(clientIp(req("http://localhost/", xff), "127.0.0.1")).toBe("203.0.113.5");
    expect(clientIp(req("http://localhost/", xff), "172.17.0.1")).toBe("203.0.113.5");
    expect(clientIp(req("http://localhost/", xff), "::ffff:127.0.0.1")).toBe("203.0.113.5");
    // From the internet straight in: not a proxy of ours, its header is the client's own.
    expect(clientIp(req("http://localhost/", xff), "198.51.100.7")).toBe("198.51.100.7");
  });

  it("a list trusts those proxies only, skipping each one's own entry", () => {
    process.env.TRUST_PROXY = "10.0.0.2, 10.0.0.3";
    const xff = { "x-forwarded-for": "6.6.6.6, 203.0.113.5, 10.0.0.3" };
    expect(clientIp(req("http://localhost/", xff), "10.0.0.2")).toBe("203.0.113.5");
    expect(clientIp(req("http://localhost/", xff), "10.0.0.9")).toBe("10.0.0.9");
  });

  it("never for this server's own HTTPS or the LAN proxy: nothing stands in front to add the entry", () => {
    process.env.TRUST_PROXY = "1";
    const xff = { "x-forwarded-for": "203.0.113.5" };
    expect(clientIp(req("https://my-mac.local:3443/", xff), "172.17.0.1")).toBe("172.17.0.1");
    expect(clientIp(req("http://localhost/", { ...xff, host: "my-mac.local:47843" }), "127.0.0.1")).toBe("127.0.0.1");
  });

  it("counts an IPv6 host by its /64 and a mapped IPv4 as itself", () => {
    expect(addressKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::ffff:203.0.113.4")).toBe("203.0.113.4");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(clientIp(req("http://localhost/"), "2001:db8:1:2:3:4:5:6")).toBe(clientIp(req("http://localhost/"), "2001:db8:1:2:ffff::9"));
  });
});
