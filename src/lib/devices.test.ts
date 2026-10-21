import { describe, expect, it } from "vitest";
import { detectPlatform, formatBytes, installUrl } from "./devices";

describe("devices", () => {
  it("tells phones from computers", () => {
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe("desktop");
  });

  it("points new devices at the Tailscale name, not at localhost", () => {
    expect(installUrl(["https://mac.tail1.ts.net:47823"], "http://localhost:47823")).toBe("https://mac.tail1.ts.net:47823/install");
    expect(installUrl(["https://mac.tail1.ts.net:47823"], "https://mac.tail1.ts.net:47823")).toBe("https://mac.tail1.ts.net:47823/install");
    expect(installUrl([], "http://localhost:3000")).toBe("http://localhost:3000/install");
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("1 KB");
    expect(formatBytes(13_000_000)).toBe("12.4 MB");
  });
});
