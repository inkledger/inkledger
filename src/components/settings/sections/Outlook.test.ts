import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { fakeTrpc, type FakeQuery } from "@/lib/testing/fakeTrpc";

const queries: Record<string, FakeQuery> = {};
vi.mock("@/lib/trpc", () => ({ trpc: fakeTrpc(queries) }));

vi.stubGlobal("window", { location: { protocol: "http:", origin: "http://localhost" } });

const { OutlookSection } = await import("./Outlook");
const draw = () => renderToString(createElement(OutlookSection));

describe("the Outlook add-in's key", () => {
  it("offers no way to make a key while it is unknown whether one exists", () => {
    // Making a key replaces the existing one, which would cut off an installed add-in.
    queries["mails.addinKey"] = { error: new Error("offline") };
    const failed = draw();
    expect(failed).not.toContain("Make the add-in key");
    expect(failed).toContain("Retry");
    delete queries["mails.addinKey"];
    expect(draw()).not.toContain("Make the add-in key");
  });

  it("offers to make one once the server said there is none", () => {
    queries["mails.addinKey"] = { data: null };
    expect(draw()).toContain("Make the add-in key");
  });
});
