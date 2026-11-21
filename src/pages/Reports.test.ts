import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { fakeTrpc, fakeWindow, type FakeQuery } from "@/lib/testing/fakeTrpc";

const queries: Record<string, FakeQuery> = {};
vi.mock("@/lib/trpc", () => ({ trpc: fakeTrpc(queries) }));
vi.stubGlobal("window", fakeWindow());

const { default: Reports } = await import("./Reports");
const draw = (url: string) => renderToString(createElement(MemoryRouter, { initialEntries: [url] }, createElement(Reports)));
/** The export button as drawn: its opening tag tells whether it is disabled. */
const exportButton = (html: string) => /<button[^>]*>(?:(?!<\/button>).)*Export CSV/s.exec(html)?.[0] ?? "";
const report = { rows: [{ key: "APP-1", label: "APP-1", seconds: 3600, entries: 1 }], totalSeconds: 3600, query: {} };

describe("exporting a report", () => {
  it("exports the rows shown for the period asked", () => {
    queries["reports.generate"] = { data: report };
    expect(exportButton(draw("/reports?from=2026-10-01&to=2026-10-31&group=issue"))).not.toContain('disabled=""');
  });

  it("not while the previous period's rows stand in for the new one's", () => {
    queries["reports.generate"] = { data: report, placeholder: true };
    expect(exportButton(draw("/reports?from=2026-10-01&to=2026-10-31&group=issue"))).toContain('disabled=""');
  });

  it("not for a range that can't be asked (its queries stay off, the old rows on screen)", () => {
    queries["reports.generate"] = { data: report, placeholder: true };
    expect(exportButton(draw("/reports?from=2026-10-31&to=2026-10-01&group=issue"))).toContain('disabled=""');
  });
});
