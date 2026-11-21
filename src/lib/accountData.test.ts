import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("signing out", () => {
  it("forgets what this device keeps of the account: timer notes, Desk folders, the pinboard's board", async () => {
    const storage = memoryStorage();
    storage.setItem("ikl.timerNote.3:APP-1", "half a note");
    storage.setItem("ikl-pinboard-board", "12");
    storage.setItem("ikl-note-draft:v1:7:new:a:b", "{}");
    const deleteDatabase = vi.fn();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("indexedDB", { deleteDatabase });
    const { forgetAccountData } = await import("./accountData");
    forgetAccountData();
    expect([...storage.data.keys()]).toEqual(["ikl-note-draft:v1:7:new:a:b"]);
    expect(deleteDatabase).toHaveBeenCalledWith("inkledger-desk-code");
  });

  it("the Desk chat starts empty for the next account", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify({ error: "no" }), { status: 500 })));
    const chat = await import("./desk/chat");
    const { forgetSessionState } = await import("./accountData");
    await chat.ask("What is APP-1 about?", []);
    const shown = () => renderToString(createElement(() => createElement("p", null, chat.useDeskChat().messages.length)));
    expect(shown()).toBe("<p>2</p>");
    forgetSessionState();
    expect(shown()).toBe("<p>0</p>");
  });
});
