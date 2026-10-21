import { beforeAll, describe, it, expect, vi } from "vitest";

process.env.DATABASE_URL = ":memory:";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]),
}));

import { en } from "@contracts/i18n/en";
import { it as itDict } from "@contracts/i18n/it";
import { conflictMessage } from "@contracts/placement";
import { withLocale } from "./lib/i18n";

type Node = string | { one: string; other: string } | { [k: string]: Node };

/** "a.b.c" paths to every text of a dictionary tree (a Plural counts as one). */
function paths(node: Node, prefix = ""): string[] {
  if (typeof node === "string") return [prefix];
  if ("other" in node && typeof node.other === "string") return [prefix];
  return Object.entries(node).flatMap(([k, v]) => paths(v, prefix ? `${prefix}.${k}` : k));
}

describe("i18n dictionaries", () => {
  it("English and Italian have exactly the same keys", () => {
    const enKeys = paths(en).sort();
    const itKeys = paths(itDict).sort();
    expect(itKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !itKeys.includes(k))).toEqual([]);
    expect(enKeys.length).toBeGreaterThan(0);
  });
});

describe("server messages follow the request locale", () => {
  const at = (h: number) => new Date(2025, 0, 6, h, 0);
  const hits = [{ start: at(9), seconds: 3600, label: "ABC-1" }];

  it("shared helpers answer in English or Italian", () => {
    expect(withLocale("en", () => conflictMessage(hits))).toBe("Overlaps ABC-1 09:00–10:00");
    expect(withLocale("it", () => conflictMessage(hits))).toBe("Si sovrappone a ABC-1 09:00–10:00");
  });

  // Booting the app (database and migrations) is setup, not the test's time.
  let app: typeof import("./boot").default;
  beforeAll(async () => {
    app = (await import("./boot")).default;
  });

  it("a procedure error uses the x-locale header of the request", async () => {
    const call = async (locale: string) => {
      const res = await app.request("http://localhost/api/trpc/auth.activate", {
        method: "POST",
        headers: { "content-type": "application/json", "x-locale": locale },
        body: JSON.stringify({
          json: { siteUrl: "ftp://acme.example", deployment: "cloud", username: "a@b.c", secret: "x", authType: "basic", newUsername: "abc", newPassword: "a long enough password" },
        }),
      });
      const body = (await res.json()) as { error: { json: { message: string } } };
      return body.error.json.message;
    };
    expect(await call("en")).toBe("Only http(s) URLs are allowed");
    expect(await call("it")).toBe("Sono ammessi solo URL http(s)");
  });

  it("refused input reads as words with the fields named, never the validator's JSON", async () => {
    const res = await app.request("http://localhost/api/trpc/auth.activate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-locale": "it" },
      body: JSON.stringify({ json: { siteUrl: 42 } }),
    });
    const body = (await res.json()) as { error: { json: { message: string; data: { fields?: Record<string, string> } } } };
    expect(body.error.json.message).toBe(itDict.server.input.invalid);
    expect(body.error.json.message).not.toContain('"code"');
    expect(body.error.json.data.fields).toMatchObject({ siteUrl: itDict.server.input.invalidField });
  });
});
