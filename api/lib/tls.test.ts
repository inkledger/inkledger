import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTls } from "./tls";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("loadTls", () => {
  let root: string;
  let good: string;
  let other: string;

  const pair = (name: string) => {
    const dir = path.join(root, name);
    execFileSync("mkdir", [dir]);
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "server.key"), "-out", path.join(dir, "server.crt"), "-subj", "/CN=test", "-days", "100"],
      { stdio: "ignore" },
    );
    return dir;
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "ikl-tls-"));
    good = pair("good");
    other = pair("other");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("loads a matching pair, with no warning far from its end", () => {
    const tls = loadTls(good);
    expect(tls).toMatchObject({ on: true, warning: null });
  });

  it("stays off, and says so, when the folder is missing or empty", () => {
    expect(loadTls(path.join(root, "missing"))).toMatchObject({ on: false, reason: expect.stringContaining("no certificate") });
    const empty = mkdtempSync(path.join(root, "empty-"));
    expect(loadTls(empty)).toMatchObject({ on: false, reason: expect.stringContaining("no certificate") });
  });

  it("stays off when the key belongs to another certificate", () => {
    const mixed = mkdtempSync(path.join(root, "mixed-"));
    copyFileSync(path.join(good, "server.crt"), path.join(mixed, "server.crt"));
    copyFileSync(path.join(other, "server.key"), path.join(mixed, "server.key"));
    expect(loadTls(mixed)).toMatchObject({ on: false, reason: expect.stringContaining("not usable") });
  });

  it("stays off on files that are no certificate at all", () => {
    const junk = mkdtempSync(path.join(root, "junk-"));
    writeFileSync(path.join(junk, "server.crt"), "not a certificate");
    writeFileSync(path.join(junk, "server.key"), "not a key");
    expect(loadTls(junk)).toMatchObject({ on: false, reason: expect.stringContaining("not usable") });
  });

  it("warns near the end, and after it, still serving", () => {
    expect(loadTls(good, new Date(Date.now() + 80 * DAY_MS))).toMatchObject({ on: true, warning: expect.stringContaining("expires in") });
    expect(loadTls(good, new Date(Date.now() + 120 * DAY_MS))).toMatchObject({ on: true, warning: expect.stringContaining("expired on") });
  });
});
