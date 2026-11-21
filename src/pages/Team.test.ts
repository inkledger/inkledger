import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { fakeTrpc, fakeWindow, type FakeQuery } from "@/lib/testing/fakeTrpc";

const queries: Record<string, FakeQuery> = {};
vi.mock("@/lib/trpc", () => ({ trpc: fakeTrpc(queries) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: 1, permissions: ["viewTeamTime"] } }) }));
vi.mock("@/components/app/lazyPart", () => ({ lazyPart: () => () => null }));
vi.stubGlobal("window", fakeWindow());

const { default: Team } = await import("./Team");
const draw = (url: string) => renderToString(createElement(MemoryRouter, { initialEntries: [url] }, createElement(Team)));
const empty = { people: [], elapsedDays: 0, loggedSeconds: 0, targetSeconds: 0, coverage: null, previous: null };

describe("the Team page while another range loads", () => {
  it("says a range is empty only from its own figures", () => {
    queries["team.overview"] = { data: empty };
    expect(draw("/team?from=2026-10-01&to=2026-10-31")).toContain("No time logged in this period");
    // The previous range's empty figures, kept on screen while this one loads: not this range's verdict.
    queries["team.overview"] = { data: empty, placeholder: true };
    expect(draw("/team?from=2026-11-01&to=2026-11-30")).not.toContain("No time logged in this period");
  });
});
