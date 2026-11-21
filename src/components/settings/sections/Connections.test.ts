import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { fakeTrpc, fakeWindow, type FakeQuery } from "@/lib/testing/fakeTrpc";

const queries: Record<string, FakeQuery> = {};
vi.mock("@/lib/trpc", () => ({ trpc: fakeTrpc(queries) }));
vi.stubGlobal("window", fakeWindow());

const { ConnectionsSection } = await import("./Connections");
const draw = () => renderToString(createElement(MemoryRouter, null, createElement(ConnectionsSection)));

describe("the connections list", () => {
  it("says it couldn't be read, with a retry, instead of an empty section", () => {
    queries["connections.list"] = { error: new Error("offline") };
    expect(draw()).toContain("Retry");
  });
});
