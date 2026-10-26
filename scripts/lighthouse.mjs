// Lighthouse on the production build, every scenario three times, desktop and mobile: a fresh
// server on a temporary database (e2e/harness.mjs), providers read-only, no store, no weather, no
// sync, fictitious data. Reports (JSON + HTML) and a summary in perf/lighthouse/<date>-<sha>/.
//   pnpm build && node scripts/lighthouse.mjs [--only login,dashboard] [--form desktop|mobile]
//                                             [--runs 3] [--mods <unsigned modules build>] [--gate]
// --gate: exit 1 unless every run of every scenario scores 100 in all four categories.
// Nothing is chosen after seeing scores: the scenarios below are the whole matrix (LH-1).
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start } from "../e2e/harness.mjs";
import { chromiumPath } from "./chromium.mjs";

const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
};
const only = arg("only")?.split(",") ?? null;
const forms = arg("form") ? [arg("form")] : ["desktop", "mobile"];
const runs = Number(arg("runs") ?? 3);
const modsBuild = arg("mods");
const gate = process.argv.includes("--gate");
const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];

const SETTINGS = ["account", "connections", "buckets", "clients", "users", "schedule", "timers", "notifications", "appearance", "pinboard", "todos", "links", "backup", "servers", "devices", "store", "permissions"];
/** The matrix (LH-1). `auth: false` loads signed out. Error routes are left to the functional tests. */
const SCENARIOS = [
  { id: "login", path: "/login", auth: false },
  { id: "install", path: "/install", auth: false },
  { id: "invite", path: "/invite/…", auth: false },
  { id: "dashboard", path: "/" },
  { id: "issues", path: "/issues" },
  { id: "issue-by-key", path: "/issues/DEMO-101" },
  { id: "issue-by-ref", path: "/issues/1/DEMO-101" },
  { id: "timesheet", path: "/timesheet" },
  { id: "board", path: "/board" },
  { id: "pinboard", path: "/pinboard" },
  { id: "todos", path: "/todos" },
  { id: "reports", path: "/reports" },
  { id: "info", path: "/info" },
  { id: "settings", path: "/settings" },
  ...SETTINGS.map(s => ({ id: `settings-${s}`, path: `/settings/${s}` })),
].filter(s => !only || only.includes(s.id));

/** Modules (optional): the unsigned build, signed here with a throwaway key and fixture licences. */
function moduleEnv() {
  if (!modsBuild) return { env: {}, seed: async () => undefined, ids: [] };
  const KEY = generateKeyPairSync("ed25519");
  const { signEnvelope } = awaitImport("../api/vendor/seal/envelope.ts");
  const { sha256hex, signManifest } = awaitImport("../api/vendor/seal/package.ts");
  const ids = readdirSync(modsBuild).filter(id => existsSync(join(modsBuild, id, "manifest.unsigned.json")));
  const dir = join(mkdtempSync(join(tmpdir(), "ikl-lh-mods-")), "modules");
  for (const id of ids) {
    const meta = JSON.parse(readFileSync(join(modsBuild, "..", "packages", id, "meta.json"), "utf8"));
    const out = join(dir, id);
    mkdirSync(out, { recursive: true });
    const files = {};
    for (const f of readdirSync(join(modsBuild, id)).filter(f => f !== "manifest.unsigned.json")) {
      const bytes = readFileSync(join(modsBuild, id, f));
      writeFileSync(join(out, f), bytes);
      files[f] = sha256hex(bytes);
    }
    const manifest = { ...meta, files };
    writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(out, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey));
  }
  const license = id => signEnvelope(Buffer.from(JSON.stringify({ id: `L-${id}`, email_hash: "h", product: `inkledger.${id}`, issued: 1, v: 1 })), "inkledger-license-v1\n", KEY.privateKey);
  return {
    ids,
    env: { MODULES_DIR: dir, MODULES_TRUST_EXTRA_KEY: KEY.publicKey.export({ type: "spki", format: "pem" }).toString(), MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" },
    seed: db => db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify(ids.map(license)), Date.now()),
  };
}
// The seal helpers are TypeScript, loaded the same way the e2e tests load them (node strips types).
const loaded = {};
function awaitImport(p) {
  if (!loaded[p]) throw new Error(`${p} not preloaded`);
  return loaded[p];
}
if (modsBuild) for (const p of ["../api/vendor/seal/envelope.ts", "../api/vendor/seal/package.ts"]) loaded[p] = await import(p);

const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim();
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const OUT = join(new URL("..", import.meta.url).pathname, "perf/lighthouse", `${stamp}-${sha}`);
mkdirSync(OUT, { recursive: true });

const mods = moduleEnv();
const INVITE = "lighthouse-invite-token";
const app = await start({
  seed: async db => {
    // A pending invite (a new account, no password yet) for the public invite page.
    await db.q("INSERT INTO users (id, username, password_hash, role, email, display_name, created_at) VALUES (2, 'gverdi', NULL, 'user', 'gverdi', 'Giulia Verdi', ?)", Date.now());
    await db.q("INSERT INTO invites (id, user_id, created_by, expires_at, created_at) VALUES (?, 2, 1, ?, ?)", createHash("sha256").update(INVITE).digest("hex"), Date.now() + 86_400_000, Date.now());
    await mods.seed(db);
  },
  env: { PROVIDERS_READ_ONLY: "1", JIRA_READ_ONLY: "1", STORE_URL: "off", WEATHER: "off", SYNC_INTERVAL_MIN: "0", ...mods.env },
});
const cookie = (await app.context.cookies(app.base)).map(c => `${c.name}=${c.value}`).join("; ");
await app.page.close();

const results = [];
try {
  const scenarios = [...SCENARIOS];
  // With modules: the dashboard with each one alone is not possible on one server (all are licensed),
  // so the dashboard and Store with all of them is measured, named apart.
  if (mods.ids.length) scenarios.push({ id: "dashboard-all-mods", path: "/" }, { id: "store-all-mods", path: "/settings/store" });
  for (const s of scenarios) {
    if (s.id === "invite") {
      s.path = `/invite/${INVITE}`;
    }
    for (const form of forms) {
      for (let run = 1; run <= runs; run++) {
        const flags = {
          output: ["json", "html"],
          logLevel: "error",
          onlyCategories: CATEGORIES,
          formFactor: form,
          screenEmulation: form === "mobile" ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false } : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
          // The version's own default throttling for each form factor (simulated), stated in the report.
          throttlingMethod: "simulate",
          ...(form === "desktop" ? { throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 } } : {}),
          extraHeaders: s.auth === false ? {} : { Cookie: cookie },
          disableStorageReset: false,
        };
        const name = `${s.id}.${form}.${run}`;
        // Each run in its own process (memory stays bounded over the whole matrix).
        const once = () => promisify(execFile)(process.execPath, [new URL("./lighthouse-run.mjs", import.meta.url).pathname, `${app.base}${s.path}`, JSON.stringify(flags), join(OUT, name)], { maxBuffer: 1 << 22 });
        // A run that broke (the browser, not the page) is tried once more; its score is never touched.
        await once().catch(once);
        const lhr = JSON.parse(readFileSync(join(OUT, `${name}.json`), "utf8"));
        const scores = Object.fromEntries(CATEGORIES.map(c => [c, Math.round((lhr.categories[c]?.score ?? 0) * 100)]));
        const metric = id => lhr.audits[id]?.numericValue ?? null;
        const failing = Object.values(lhr.audits)
          .filter(a => a.score !== null && a.score < 1 && a.scoreDisplayMode !== "informative" && a.scoreDisplayMode !== "notApplicable" && a.scoreDisplayMode !== "manual")
          .map(a => a.id);
        results.push({ scenario: s.id, path: s.path, form, run, scores, lcp: metric("largest-contentful-paint"), cls: metric("cumulative-layout-shift"), tbt: metric("total-blocking-time"), failing, url: lhr.finalDisplayedUrl });
        writeFileSync(join(OUT, "summary.partial.json"), JSON.stringify(results));
        console.log(`${name.padEnd(36)} ${CATEGORIES.map(c => String(scores[c]).padStart(3)).join(" ")}  ${failing.slice(0, 6).join(",")}`);
      }
    }
  }
} finally {
  await app.stop();
}

const meta = { sha, at: new Date().toISOString(), lighthouse: JSON.parse(readFileSync(new URL("../node_modules/lighthouse/package.json", import.meta.url), "utf8")).version, chromium: chromiumPath(), runs, forms, mods: mods.ids };
writeFileSync(join(OUT, "summary.json"), JSON.stringify({ meta, results }, null, 2));
const below = results.filter(r => CATEGORIES.some(c => r.scores[c] < 100));
console.log(`\n${results.length} runs, ${below.length} below 100 in some category. Reports: ${OUT}`);
if (modsBuild) rmSync(join(mods.env.MODULES_DIR, ".."), { recursive: true, force: true });
if (gate && below.length) process.exit(1);
