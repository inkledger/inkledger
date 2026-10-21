import { describe, it, expect, vi } from "vitest";

// Must be set before env.ts is evaluated.
process.env.JIRA_READ_ONLY = "1";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

describe("JIRA_READ_ONLY", () => {
  it("blocks every write to Jira and still allows reads", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ accountId: "a", displayName: "M" }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("./client");
    const creds = {
      siteUrl: "https://acme.atlassian.net",
      deployment: "cloud" as const,
      authType: "basic" as const,
      username: "m@x.it",
      secret: "t",
    };
    await expect(client.getMyself(creds)).resolves.toMatchObject({ accountId: "a" });
    await expect(client.addComment(creds, "PRJ-1", "hello")).rejects.toThrow(/read-only/);
    // the blocked call never reached the network
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
