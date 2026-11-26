// The Store switched on for layout checks (the visual sweep, store-layout): a stub Worker with six
// modules of long Italian names (a pending request, one installed whose newer build needs a newer
// inkledger, a paid one, one coming soon), two of them installed and licensed here.
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signEnvelope } from "../../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../../api/vendor/seal/package.ts";

const FIXTURES = new URL("./modules/", import.meta.url).pathname;
const SLOTS = { tune: ["settings"], hello: ["sidebar-footer"] };
const loc = (it, en = it) => ({ en, it });

const item = (id, over = {}) => ({
  id,
  product: `inkledger.${id}`,
  version: "1.0.0",
  hostApi: { min: 1, max: 1 },
  name: loc(`Modulo dal nome molto lungo ${id}`, `A module with a long name ${id}`),
  tagline: loc("Un piccolo extra con una descrizione abbastanza lunga da andare a capo nella scheda.", "A small extra with a description long enough to wrap in its card."),
  mode: "request",
  price: { amount: 2.99, currency: "EUR" },
  methods: { card: true, bitcoin: "soon" },
  ...over,
});

const ITEMS = [
  // Installed here, its newest build needs a newer inkledger: the long status line.
  item("tune", { name: loc("Accordatore delle impostazioni personali", "Personal settings tuner"), badge: "beta", builds: [{ version: "1.0.0", hostApi: { min: 1, max: 1 }, slots: ["settings"], build: "" }, { version: "2.0.0", hostApi: { min: 99, max: 99 }, slots: ["settings"], build: "b".repeat(32) }] }),
  item("hello", { name: loc("Saluto cordiale nella barra laterale", "Friendly hello in the sidebar"), badge: "free" }),
  item("waiting", { name: loc("Richiesta in attesa di approvazione", "Request waiting for approval") }),
  item("paidone", { name: loc("Modulo a pagamento con un nome lunghissimo", "A paid module with a very long name"), mode: "paid", badge: "new" }),
  item("later", { name: loc("In arrivo prossimamente", "Coming soon"), mode: "soon" }),
  item("plain", { name: loc("Semplice", "Plain") }),
];

/** Starts the stub Worker and installs the two modules; env for the server, seed for its database, close after. */
export async function storeFixture() {
  const key = generateKeyPairSync("ed25519");
  const pem = key.publicKey.export({ type: "spki", format: "pem" }).toString();
  const license = id => signEnvelope(Buffer.from(JSON.stringify({ id: `L-${id}`, email_hash: "h", product: `inkledger.${id}`, issued: 1, v: 1 })), "inkledger-license-v1\n", key.privateKey);
  const modulesDir = join(mkdtempSync(join(tmpdir(), "ikl-e2e-store-")), "modules");
  for (const id of ["tune", "hello"]) {
    const code = readFileSync(join(FIXTURES, id, "index.js"));
    const manifest = { id, version: "1.0.0", product: `inkledger.${id}`, entry: "index.js", hostApi: { min: 1, max: 1 }, slots: SLOTS[id], name: ITEMS.find(i => i.id === id).name, files: { "index.js": sha256hex(code) } };
    mkdirSync(join(modulesDir, id), { recursive: true });
    writeFileSync(join(modulesDir, id, "index.js"), code);
    writeFileSync(join(modulesDir, id, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(modulesDir, id, "manifest.sig"), signManifest(manifest, "inkledger-package-v1\n", key.privateKey));
  }
  const server = createServer((req, res) => {
    const send = (data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.url === "/catalog") return send({ v: 1, items: ITEMS });
    if (req.url?.startsWith("/request/")) return send({ status: "pending" });
    return send({ error: "nope" }, 404);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return {
    ids: ITEMS.map(i => i.id),
    env: { STORE_URL: `http://127.0.0.1:${server.address().port}`, MODULES_DIR: modulesDir, MODULES_TRUST_EXTRA_KEY: pem, MODULES_TRUST_EXTRA_KEY_IN_PRODUCTION: "1" },
    seed: async db => {
      await db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify([license("tune"), license("hello")]), Date.now());
      const pending = [{ token: "w".repeat(43), product: "inkledger.waiting", kind: "request", status: "pending", created: Date.now(), by: 1, for: 1, payer: { kind: "user", id: 1 } }];
      await db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('store.pending', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", JSON.stringify(pending), Date.now());
    },
    close: () => {
      server.close();
      rmSync(join(modulesDir, ".."), { recursive: true, force: true });
    },
  };
}
