// Safety net: tests run on an in-process database, never on a real one.
// Set before any test file loads, so a module that reads the environment
// early (dotenv picks up .env, which points at the dev database) still gets it.
if (!process.env.DATABASE_URL?.startsWith("pglite:")) process.env.DATABASE_URL = ":memory:";

// Safety net: tests never read the checkout's own installed modules (data/modules holds a developer's real,
// licensed bundles): an empty folder per run unless a test file names its own.
if (!process.env.MODULES_DIR) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.MODULES_DIR = mkdtempSync(join(tmpdir(), "ikl-test-modules-"));
}

// Safety net: a test that forgets to stub fetch must never reach a real Jira.
// Files override this with vi.stubGlobal("fetch", …).
globalThis.fetch = () => Promise.reject(new Error("Network disabled in tests: stub fetch"));
