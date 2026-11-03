import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "./en";

// A call that forgets one of its message's placeholders shows it as written ("added (2/{max})",
// "Link to {issue}": both on screen until 2 Nov). Every t("key", { ... }) with a literal object, and
// every t("key") alone, must give each {name} its English message has.
const message = (key: string): unknown => key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), en);
const placeholders = (m: unknown): Set<string> => {
  const texts = typeof m === "string" ? [m] : m && typeof m === "object" ? Object.values(m).filter((v): v is string => typeof v === "string") : [];
  return new Set(texts.flatMap(text => [...text.matchAll(/\{(\w+)\}/g)].map(x => x[1])));
};
/** The object literal's top-level names, or null when it spreads (unknown names). */
function names(source: string): Set<string> | null {
  const body = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Set<string>();
  let depth = 0, part = "";
  const parts: string[] = [];
  for (const ch of body) {
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) { parts.push(part); part = ""; } else part += ch;
  }
  parts.push(part);
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (p.startsWith("...")) return null;
    const m = /^(\w+)\s*(:|$)/.exec(p);
    if (m) out.add(m[1]);
  }
  return out;
}
describe("translated messages get every value they name", () => {
  it("in every call with literal values, in the app and on the server", () => {
    const sources = ["src", "api"].flatMap(dir => readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter(file => /\.(ts|tsx)$/.test(file) && !/\.test\./.test(file) && !file.startsWith("parity"))
      .map(file => join(dir, file)));
    const problems: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bt\(\s*"([a-z][\w.]*)"\s*(?:,\s*\{((?:[^{}]|\{[^{}]*\})*)\})?\s*\)/g)) {
        const msg = message(m[1]);
        if (msg === undefined) continue;
        const need = placeholders(msg);
        if (need.size === 0) continue;
        const given = m[2] === undefined ? new Set<string>() : names(m[2]);
        if (given === null) continue;
        const missing = [...need].filter(name => !given.has(name));
        if (missing.length) problems.push(`${file}: t("${m[1]}") misses {${missing.join("}, {")}}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
