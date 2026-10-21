import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ikl-downloads-"));
process.env.DATABASE_URL = ":memory:";
process.env.DOWNLOADS_DIR = DIR;
process.env.ALLOWED_HOSTS = "my-mac.tail1.ts.net,localhost";

const APK = Buffer.from("PK fake apk");
const manifest = (over: Record<string, unknown> = {}) => ({
  android: {
    version: "0.2.0",
    file: "inkledger.apk",
    size: APK.length,
    sha256: "a".repeat(64),
    builtAt: 1_760_000_000_000,
    ...over,
  },
});

describe("app downloads (public, tailnet only)", () => {
  let app: typeof import("./boot").default;
  const get = (url: string, host = "my-mac.tail1.ts.net") => app.request(url, { headers: { host } });

  beforeAll(async () => {
    app = (await import("./boot")).default;
  });
  beforeEach(() => {
    for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f));
  });

  it("offers nothing until a build is published", async () => {
    const res = await get("/api/downloads/manifest.json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ android: null });
    expect((await get("/api/downloads/inkledger.apk")).status).toBe(404);
  });

  it("serves the published APK without login, as a download", async () => {
    fs.writeFileSync(path.join(DIR, "inkledger.apk"), APK);
    fs.writeFileSync(path.join(DIR, "manifest.json"), JSON.stringify(manifest()));
    const m = (await (await get("/api/downloads/manifest.json")).json()) as { android: { version: string } };
    expect(m.android.version).toBe("0.2.0");
    const res = await get("/api/downloads/inkledger.apk");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="inkledger.apk"/);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(APK);
  });

  it("serves only the file the manifest names", async () => {
    fs.writeFileSync(path.join(DIR, "inkledger.apk"), APK);
    fs.writeFileSync(path.join(DIR, "other.apk"), APK);
    fs.writeFileSync(path.join(DIR, "manifest.json"), JSON.stringify(manifest()));
    expect((await get("/api/downloads/other.apk")).status).toBe(404);
    expect((await get("/api/downloads/..%2Fmanifest.json")).status).toBe(404);
    expect((await get("/api/downloads/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd")).status).toBe(404);
  });

  it("ignores a manifest naming a missing or unsafe file", async () => {
    fs.writeFileSync(path.join(DIR, "manifest.json"), JSON.stringify(manifest()));
    expect(await (await get("/api/downloads/manifest.json")).json()).toEqual({ android: null });
    fs.writeFileSync(path.join(DIR, "manifest.json"), JSON.stringify(manifest({ file: "../app.db" })));
    expect(await (await get("/api/downloads/manifest.json")).json()).toEqual({ android: null });
  });

  it("answers only on the allowed hosts", async () => {
    fs.writeFileSync(path.join(DIR, "inkledger.apk"), APK);
    fs.writeFileSync(path.join(DIR, "manifest.json"), JSON.stringify(manifest()));
    expect((await get("/api/downloads/inkledger.apk", "evil.example.com")).status).toBe(421);
    expect((await get("/api/downloads/inkledger.apk", "localhost:47823")).status).toBe(200);
  });
});
