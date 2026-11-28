import { describe, it, expect, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

/** What the tracker answers, asked with someone's own connection, becomes one of a few reasons (api/chat/access.ts). */
const answer = { current: async (): Promise<unknown> => null };
vi.mock("../sync/engine", () => ({ boundTracker: (conn: { type: string }) => (conn.type === "none" ? null : { getIssue: () => answer.current() }) }));

describe("lookIssue", () => {
  const conn = { id: 1, type: "jira" } as unknown as import("@db/schema").Connection;
  const ref = { remoteId: "10001", key: "APP-1" };

  it("sees the issue, or says why not", async () => {
    const { lookIssue } = await import("./access");
    const { ProviderError } = await import("../providers/core/errors");
    const issue = { remoteId: "10001", key: "APP-1" };
    answer.current = async () => issue;
    expect(await lookIssue(conn, ref)).toEqual({ reach: "ok", issue });
    answer.current = async () => null;
    expect((await lookIssue(conn, ref)).reach).toBe("noAccess");
    for (const [kind, reach] of [
      ["notFound", "noAccess"],
      ["forbidden", "noAccess"],
      ["auth", "reconnect"],
      ["unavailable", "unreachable"],
      ["timeout", "unreachable"],
      ["rateLimit", "unreachable"],
      ["incompatible", "unreachable"],
    ] as const) {
      answer.current = async () => {
        throw new ProviderError(kind, "x");
      };
      expect((await lookIssue(conn, ref)).reach, kind).toBe(reach);
    }
    answer.current = async () => {
      throw new Error("socket hang up");
    };
    expect((await lookIssue(conn, ref)).reach).toBe("unreachable");
    expect((await lookIssue({ ...conn, type: "none" }, ref)).reach).toBe("unsupported");
  });
});
