import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

describe("a page from another build (T9)", () => {
  afterEach(() => {
    delete process.env.APP_BUILD;
  });

  const remembered = async (build?: string) => {
    const app = (await import("./boot")).default;
    const res = await app.request("http://localhost/api/trpc/auth.remembered", { headers: build ? { "x-app-build": build } : {} });
    return { status: res.status, body: (await res.json()) as { error?: { json: { message: string } } } };
  };

  it("is told to reload when the server runs a newer build; the same build, or none sent, passes", async () => {
    process.env.APP_BUILD = "b2";
    expect(await remembered("b1")).toMatchObject({ status: 409, body: { error: { json: { message: "APP_BUILD_CHANGED" } } } });
    expect((await remembered("b2")).status).toBe(200);
    expect((await remembered()).status).toBe(200);
  });

  it("a server with no build of its own (development) never asks", async () => {
    expect((await remembered("whatever")).status).toBe(200);
  });
});
