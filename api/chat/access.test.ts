import { describe, it, expect, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

/** What the tracker answers, asked with someone's own connection, becomes one of a few reasons (api/chat/access.ts). */
const answer = { current: async (): Promise<unknown> => null };
const asked: unknown[] = [];
vi.mock("../sync/engine", () => ({
  boundTracker: (conn: { type: string }) =>
    conn.type === "none"
      ? null
      : {
          getIssue: () => answer.current(),
          findIssue: async (_x: unknown, handle: unknown) => {
            asked.push(handle);
            const issue = await answer.current();
            return issue ? { kind: "found", issue } : { kind: "none" };
          },
        },
}));

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

  it("finds an issue never imported by its key (the tracker's lookup, not by an id the caller doesn't have)", async () => {
    const { findIssueByKey } = await import("./access");
    const { ProviderError } = await import("../providers/core/errors");
    const issue = { remoteId: "10002", key: "APP-2" };
    answer.current = async () => issue;
    expect(await findIssueByKey(conn, "APP-2")).toEqual({ reach: "ok", issue });
    expect(asked.at(-1)).toEqual({ key: "APP-2" });
    answer.current = async () => null;
    expect((await findIssueByKey(conn, "APP-2")).reach).toBe("noAccess");
    answer.current = async () => {
      throw new ProviderError("auth", "x");
    };
    expect((await findIssueByKey(conn, "APP-2")).reach).toBe("reconnect");
  });
});
