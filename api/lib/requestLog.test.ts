import { describe, expect, it } from "vitest";
import { loggedPath } from "./requestLog";

describe("loggedPath: what the request log may show of a URL", () => {
  it("drops the query (tRPC inputs: an invite's token, search words)", () => {
    expect(loggedPath("http://localhost/api/trpc/auth.invite?input=%7B%22token%22%3A%22secret%22%7D")).toBe("/api/trpc/auth.invite");
    expect(loggedPath("http://localhost:47823/api/trpc/issues.list,auth.me?batch=1&input=x")).toBe("/api/trpc/issues.list,auth.me");
  });

  it("hides a webhook's token, keeps which hook", () => {
    expect(loggedPath("https://ikl.example/api/hooks/12/abcdefSECRET")).toBe("/api/hooks/12/…");
  });

  it("leaves other paths as they are", () => {
    expect(loggedPath("http://localhost/api/health")).toBe("/api/health");
    expect(loggedPath("http://localhost/api/issues/7/attachments")).toBe("/api/issues/7/attachments");
  });
});
