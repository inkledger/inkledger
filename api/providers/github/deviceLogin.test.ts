import { afterEach, describe, expect, it, vi } from "vitest";
import { startDeviceLogin } from "./deviceLogin";

const answering = (status: number) => vi.fn(async () => new Response("", { status }));

describe("GitHub device login", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a refusal says what kind it is; a 401 is this app's, not a connection to reconnect", async () => {
    const kinds: Record<number, string> = { 429: "rateLimit", 403: "forbidden", 400: "invalid", 401: "invalid", 503: "unavailable" };
    for (const [status, kind] of Object.entries(kinds)) {
      vi.stubGlobal("fetch", answering(Number(status)));
      await expect(startDeviceLogin(1, "GitHub")).rejects.toMatchObject({ kind, status: Number(status) });
    }
  });
});
