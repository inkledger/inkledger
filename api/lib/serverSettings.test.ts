import { describe, expect, it } from "vitest";

process.env.DATABASE_URL = ":memory:";

describe("server-wide settings", () => {
  it("changes made at once to different parts of one setting all stay", async () => {
    await (await import("../queries/connection")).resetDbForTests();
    const { setAccess, getAccess } = await import("./serverHosts");
    await Promise.all([setAccess({ tailscaleHost: "mac.example.ts.net" }), setAccess({ customHosts: ["time.example.com"] }), setAccess({ tailscalePort: 8443 })]);
    expect(await getAccess()).toEqual({ tailscaleHost: "mac.example.ts.net", tailscalePort: 8443, customHosts: ["time.example.com"] });
  });
});
