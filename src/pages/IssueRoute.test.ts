import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { fakeTrpc, fakeWindow, type FakeQuery } from "@/lib/testing/fakeTrpc";

const queries: Record<string, FakeQuery> = {};
vi.mock("@/lib/trpc", () => ({ trpc: fakeTrpc(queries) }));
vi.mock("./IssueDetail", () => ({ default: ({ issueKey }: { issueKey: string }) => createElement("p", null, `detail ${issueKey}`) }));
vi.mock("./NotFound", () => ({ default: () => createElement("p", null, "not found") }));
vi.stubGlobal("window", fakeWindow());

const { IssueByRef } = await import("./IssueRoute");
const draw = (url: string) =>
  renderToString(createElement(MemoryRouter, { initialEntries: [url] }, createElement(Routes, null, createElement(Route, { path: "/issues/:connectionId/:remoteId", element: createElement(IssueByRef) }))));

describe("opening an issue by its identity", () => {
  it("a link that can't name a connection says so, instead of loading forever", () => {
    delete queries["issues.locate"];
    expect(draw("/issues/abc/x")).toContain("not found");
  });

  it("a lookup that failed offers to try again, rather than calling the issue missing", () => {
    queries["issues.locate"] = { error: new Error("offline") };
    const html = draw("/issues/3/10001");
    expect(html).not.toContain("not found");
    expect(html).toContain("Retry");
  });

  it("still loads while the lookup runs, and opens what it found", () => {
    delete queries["issues.locate"];
    expect(draw("/issues/3/10001")).not.toContain("not found");
    queries["issues.locate"] = { data: { key: "APP-1", connectionId: 3 } };
    expect(draw("/issues/3/10001")).toContain("detail APP-1");
  });
});
