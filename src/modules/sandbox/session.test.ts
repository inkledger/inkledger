import { describe, expect, it } from "vitest";
import type { HostApiV1 } from "../types";
import type { HostApiV2 } from "../hostV2";
import { bootFrame, settle } from "./bootFrame.testkit";
import { frameMethods, type Cas } from "./methods";
import { createSessionStore, SESSION_KEYS_MAX, type SessionBackend } from "./session";

function memory(): SessionBackend & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    get length() {
      return rows.size;
    },
    key: i => [...rows.keys()][i] ?? null,
    getItem: k => rows.get(k) ?? null,
    setItem: (k, v) => void rows.set(k, v),
    removeItem: k => void rows.delete(k),
  };
}

describe("a framed module's session store", () => {
  it("each module its own keys, a cap on how many, signing out drops them all (and nothing else)", () => {
    const b = memory();
    b.setItem("app-own", "1");
    const s = createSessionStore(() => b);
    s.set("a", "greeted", "1");
    expect(s.get("a", "greeted")).toBe("1");
    expect(s.get("b", "greeted")).toBeNull();
    for (let i = 1; i < SESSION_KEYS_MAX; i++) s.set("a", `k${i}`, "x");
    expect(() => s.set("a", "one-more", "x")).toThrow("session: too many keys");
    // An existing key may still change.
    s.set("a", "greeted", "2");
    expect(s.get("a", "greeted")).toBe("2");
    s.delete("a", "greeted");
    expect(s.get("a", "greeted")).toBeNull();
    s.clear();
    expect([...b.rows.keys()]).toEqual(["app-own"]);
  });

  it("storage that throws or is missing: reads are empty, writes are lost, nothing breaks", () => {
    const broken = createSessionStore(() => {
      throw new Error("blocked");
    });
    expect(broken.get("a", "k")).toBeNull();
    expect(() => broken.set("a", "k", "v")).not.toThrow();
    expect(() => broken.clear()).not.toThrow();
    expect(createSessionStore(() => null).get("a", "k")).toBeNull();
  });

  it("reaches the frame as host.session, with no capability", async () => {
    const b = memory();
    const store = createSessionStore(() => b);
    const api = { storage: {} } as unknown as HostApiV1;
    const cas = {} as Cas;
    const seen: unknown[] = [];
    const mod = {
      id: "m",
      hostApi: 2,
      mount: {
        "dashboard-widget": (_el: unknown, host: HostApiV2) => {
          const session = host.session;
          void (async () => {
            seen.push(await session?.get("greeted"));
            await session?.set("greeted", "1");
            seen.push(await session?.get("greeted"));
            await session?.get("x".repeat(65)).catch((e: Error) => seen.push(e.message));
          })();
          return () => {};
        },
      },
    };
    bootFrame({ capabilities: [], mod, methods: frameMethods(api, cas, null, undefined, { moduleId: "m", store }).methods });
    await settle(20);
    expect(seen).toEqual([null, "1", "bad-arguments"]);
    expect(b.rows.get("ikl-module-session:m:greeted")).toBe("1");
  });
});
