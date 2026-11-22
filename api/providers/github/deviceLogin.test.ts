import { afterEach, describe, expect, it, vi } from "vitest";
import { pollDeviceLogin, startDeviceLogin } from "./deviceLogin";

const answering = (status: number) =>
  vi.fn(async () => new Response("", { status }));

describe("GitHub device login", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks for offline access and returns the complete renewable token set", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          device_code: "dev",
          user_code: "ABCD",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "gho_test",
          expires_in: 28_800,
          refresh_token: "ghr_test",
          refresh_token_expires_in: 15_552_000,
        })
      );
    vi.stubGlobal("fetch", fetcher);
    const flow = await startDeviceLogin(1, "GitHub");
    expect(
      new URLSearchParams(String(fetcher.mock.calls[0][1].body))
        .get("scope")
        ?.split(" ")
    ).toContain("offline_access");
    await expect(pollDeviceLogin(1, flow.flowId)).resolves.toEqual({
      state: "authorized",
      label: "GitHub",
      tokens: {
        v: 1,
        accessToken: "gho_test",
        accessTokenExpiresAt: 29_800_000,
        refreshToken: "ghr_test",
        refreshTokenExpiresAt: 15_553_000_000,
      },
    });
  });

  it("two polls at once ask GitHub once; a user's oldest sign-ins go past a few", async () => {
    const code = () => Response.json({ device_code: "dev", user_code: "ABCD", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 });
    const tokenCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/login/device/code")) return code();
        tokenCalls.push(String(url));
        return Response.json({ error: "authorization_pending" });
      }),
    );
    const flow = await startDeviceLogin(7, "GitHub");
    await Promise.all([pollDeviceLogin(7, flow.flowId), pollDeviceLogin(7, flow.flowId)]);
    expect(tokenCalls).toHaveLength(1);
    const later = [];
    for (let i = 0; i < 6; i++) later.push(await startDeviceLogin(7, "GitHub"));
    // The first one (and the oldest of the later ones) were dropped.
    await expect(pollDeviceLogin(7, flow.flowId)).resolves.toEqual({ state: "failed", reason: "expired" });
    await expect(pollDeviceLogin(7, later[0].flowId)).resolves.toEqual({ state: "failed", reason: "expired" });
  });

  it("still accepts a long-lived token without refresh fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            device_code: "dev-long",
            user_code: "ABCD",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          })
        )
        .mockResolvedValueOnce(Response.json({ access_token: "gho_long" }))
    );
    const flow = await startDeviceLogin(1, "GitHub");
    await expect(pollDeviceLogin(1, flow.flowId)).resolves.toMatchObject({
      state: "authorized",
      tokens: {
        accessToken: "gho_long",
        accessTokenExpiresAt: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
      },
    });
  });

  it("a refusal says what kind it is; a 401 is this app's, not a connection to reconnect", async () => {
    const kinds: Record<number, string> = {
      429: "rateLimit",
      403: "forbidden",
      400: "invalid",
      401: "invalid",
      503: "unavailable",
    };
    for (const [status, kind] of Object.entries(kinds)) {
      vi.stubGlobal("fetch", answering(Number(status)));
      await expect(startDeviceLogin(1, "GitHub")).rejects.toMatchObject({
        kind,
        status: Number(status),
      });
    }
  });
});
