// Safety net: tests run on an in-process database, never on a real one.
// Set before any test file loads, so a module that reads the environment
// early (dotenv picks up .env, which points at the dev database) still gets it.
if (!process.env.DATABASE_URL?.startsWith("pglite:")) process.env.DATABASE_URL = ":memory:";

// Safety net: a test that forgets to stub fetch must never reach a real Jira.
// Files override this with vi.stubGlobal("fetch", …).
globalThis.fetch = () => Promise.reject(new Error("Network disabled in tests: stub fetch"));
