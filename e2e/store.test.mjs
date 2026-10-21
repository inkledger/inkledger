// Settings → Store end to end against a stub store Worker: the catalog drives
// the button, a licence request installs the module by itself once approved,
// a paid module shows its price and the payment methods.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { start } from "./harness.mjs";
import { signEnvelope } from "../api/vendor/seal/envelope.ts";
import { sha256hex, signManifest } from "../api/vendor/seal/package.ts";

const KEY = generateKeyPairSync("ed25519");
const PEM = KEY.publicKey.export({ type: "spki", format: "pem" }).toString();
const CODE = readFileSync(join(new URL("./fixtures/modules/", import.meta.url).pathname, "hello", "index.js"));
const TOKEN = "t".repeat(43);
// 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64");
const license = () =>
  signEnvelope(Buffer.from(JSON.stringify({ id: "R-1", email_hash: "h", product: "inkledger.hello", issued: 1, v: 1 })), "inkledger-license-v1\n", KEY.privateKey);

function bundle() {
  const manifest = {
    id: "hello",
    version: "1.0.0",
    product: "inkledger.hello",
    entry: "index.js",
    hostApi: { min: 1, max: 1 },
    slots: ["sidebar-footer"],
    name: { en: "Hello", it: "Ciao" },
    files: { "index.js": sha256hex(CODE) },
  };
  const signature = signManifest(manifest, "inkledger-package-v1\n", KEY.privateKey);
  return JSON.stringify({ format: "seal-bundle-v1", manifest, signature, files: { "index.js": CODE.toString("base64") } });
}

const item = over => ({
  id: "hello",
  product: "inkledger.hello",
  version: "1.0.0",
  hostApi: { min: 1, max: 1 },
  name: { en: "Hello", it: "Ciao" },
  tagline: { en: "Says hello in the sidebar.", it: "Saluta nella barra laterale." },
  mode: "request",
  price: { amount: 2.99, currency: "EUR" },
  methods: { card: true, bitcoin: "soon" },
  ...over,
});

/** A stub of the store Worker; `state` is what it answers. */
async function stubWorker(state) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const send = (data, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof data === "string" ? data : JSON.stringify(data));
    };
    state.calls.push({ path: req.url, body: body ? JSON.parse(body) : undefined });
    if (req.url === "/catalog") return send({ v: 1, items: state.items });
    if (req.url === "/request") return send({ token: TOKEN });
    if (req.url === `/request/${TOKEN}`) return send(state.approved ? { status: "approved", license: state.license } : { status: "pending" });
    if (req.url === "/checkout") return send({ token: "c".repeat(43), url: `http://127.0.0.1:${server.address().port}/buy` });
    if (req.url === "/buy") return send("checkout");
    if (req.url === `/claim/${"c".repeat(43)}`) return send({ status: "pending" });
    if (req.url?.startsWith("/download/inkledger.hello?token=")) return send(bundle());
    if (req.url === "/bundle/inkledger.hello") return send(bundle());
    if (req.url?.startsWith("/img/")) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(PNG);
    }
    send({ error: "nope" }, 404);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  // Pictures point at the stub itself.
  const self = `http://127.0.0.1:${server.address().port}`;
  state.items = state.items.map(i => JSON.parse(JSON.stringify(i).replaceAll("STUB", self)));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function withStore(state, body, seed) {
  state.calls = [];
  const worker = await stubWorker(state);
  const app = await start({ seed, env: { STORE_URL: worker.url, MODULES_TRUST_EXTRA_KEY: PEM } });
  try {
    await app.page.goto(app.base + "/settings/store");
    await app.page.locator('[data-store-item="hello"]').waitFor();
    await body({ ...app, state });
    assert.deepEqual(app.errors, [], "no page errors");
  } finally {
    await app.stop();
    worker.close();
  }
}

test("a free-release module: request a licence, it installs by itself once approved", () =>
  withStore(
    {
      items: [item()],
      license: signEnvelope(
        Buffer.from(JSON.stringify({ id: "R-1", email_hash: "h", product: "inkledger.hello", issued: 1, v: 1 })),
        "inkledger-license-v1\n",
        KEY.privateKey,
      ),
    },
    async ({ page, state }) => {
      const row = page.locator('[data-store-item="hello"]');
      // During the preview: the future price crossed out, and free.
      await row.getByText("Free during the preview").waitFor();
      assert.equal(await row.locator("s").textContent(), "€2.99");
      await row.getByRole("button", { name: "Request licence" }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByLabel("Email").fill("fan@example.com");
      await sheet.getByLabel("Message (optional)").fill("Lovely");
      await sheet.getByRole("button", { name: "Send request" }).click();
      await sheet.getByText("Request sent.").waitFor();
      assert.deepEqual(state.calls.find(c => c.path === "/request")?.body, {
        product: "inkledger.hello",
        email: "fan@example.com",
        message: "Lovely",
        locale: "en",
      });
      await page.keyboard.press("Escape");
      await row.getByRole("button", { name: "Awaiting approval" }).waitFor();

      state.approved = true;
      // The page polls every 10 s; the module lands and loads in the sidebar.
      await row.getByText("Active").waitFor({ timeout: 25_000 });
      await page.getByText("Hello installed and active").waitFor();
      await page.reload();
      await page.getByTestId("module-hello").waitFor();
    },
  ));

test("a paid module shows its price; Bitcoin is listed as coming soon", () =>
  withStore({ items: [item({ mode: "paid" })] }, async ({ page, context, state }) => {
    const row = page.locator('[data-store-item="hello"]');
    await row.getByRole("button", { name: "€2.99" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.locator('[data-method="bitcoin"]').getByText("Coming soon").waitFor();
    assert.equal(await sheet.locator('[data-method="bitcoin"] input').isDisabled(), true);
    const popup = context.waitForEvent("page");
    await sheet.getByRole("button", { name: "Pay €2.99" }).click();
    await (await popup).waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/buy$/);
    assert.deepEqual(state.calls.find(c => c.path === "/checkout")?.body, { product: "inkledger.hello", method: "card" });
    await sheet.getByText("Finish the payment in the browser").waitFor();
  }));

test("a module removed by hand reinstalls from the store with its licence", () =>
  withStore(
    { items: [item()] },
    async ({ page, state }) => {
      const row = page.locator('[data-store-item="hello"]');
      await row.getByRole("button", { name: "Install" }).click();
      await row.getByText("Active").waitFor();
      assert.ok(state.calls.some(c => c.path === "/bundle/inkledger.hello" && typeof c.body?.license === "string"));
      await page.reload();
      await page.getByTestId("module-hello").waitFor();
    },
    db => db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license()]), Date.now()),
  ));

test("the product sheet shows the gallery and leads to the request in place", () =>
  withStore(
    {
      items: [
        item({
          hero: "STUB/img/hero.png",
          gallery: [
            { src: "STUB/img/1.png", caption: { en: "First picture", it: "Prima" } },
            { src: "STUB/img/2.png", caption: { en: "Second picture", it: "Seconda" } },
          ],
          description: { en: ["It says hello."], it: ["Saluta."] },
          highlights: [{ icon: "heart", title: { en: "Friendly", it: "Gentile" }, body: { en: "Very.", it: "Molto." } }],
        }),
      ],
    },
    async ({ page }) => {
      await page.getByRole("button", { name: "Details of Hello" }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByText("It says hello.").waitFor();
      await sheet.getByText("Friendly").waitFor();
      await sheet.getByText("1 / 3").waitFor();
      await sheet.getByRole("button", { name: "Next picture" }).click();
      await sheet.getByText("First picture").waitFor();
      await sheet.getByRole("button", { name: "Show picture 3" }).click();
      await sheet.getByText("Second picture").waitFor();
      assert.equal(await sheet.locator("img").first().evaluate(i => i.naturalWidth), 1, "pictures load through the server");

      // Autoplay: the progress bar runs, and stops while the pointer rests on it.
      const progress = sheet.locator("[data-gallery-progress]");
      await progress.waitFor({ state: "attached" });
      await sheet.getByRole("region", { name: "Pictures" }).hover();
      assert.equal(await progress.evaluate(el => el.style.animationPlayState), "paused");

      // Full screen: arrows and keys, Esc back to the sheet.
      await sheet.getByRole("button", { name: "Show full screen" }).first().click();
      const box = page.getByRole("dialog").last();
      await box.getByText("3 / 3").waitFor();
      await page.keyboard.press("ArrowRight");
      await box.getByText("1 / 3").waitFor();
      await page.keyboard.press("Escape");
      await sheet.getByText("It says hello.").waitFor();
      // Focus is back on the picture that opened full screen.
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Show full screen", null, { timeout: 2000 });

      await sheet.getByRole("button", { name: "Request licence" }).click();
      await sheet.getByLabel("Email").waitFor();
      await sheet.getByText("By continuing you accept the").waitFor();
      await sheet.getByRole("button", { name: "Back" }).click();
      await sheet.getByText("It says hello.").waitFor();
    },
  ));

test("with reduced motion the gallery stays still", () =>
  withStore(
    { items: [item({ hero: "STUB/img/hero.png", gallery: [{ src: "STUB/img/1.png", caption: { en: "One", it: "Uno" } }] })] },
    async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.reload();
      await page.getByRole("button", { name: "Details of Hello" }).click();
      await page.getByRole("dialog").getByText("1 / 2").waitFor();
      assert.equal(await page.locator("[data-gallery-progress]").count(), 0);
    },
  ));

test("a licence downloads as a file, is removed, and comes back from that file", () =>
  withStore(
    { items: [item()] },
    async ({ page, dir }) => {
      const card = page.locator('[data-store-item="hello"]');
      await card.getByRole("button", { name: "Install" }).click();
      await card.getByRole("button", { name: "Manage Hello (Active)" }).click();
      await page.getByText("Valid for good on this server.", { exact: false }).waitFor();
      const download = page.waitForEvent("download");
      await page.getByRole("menuitem", { name: "Download licence" }).click();
      const file = join(dir, "hello.ikllicense");
      await (await download).saveAs(file);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).format, "inkledger-license-v1");

      await card.getByRole("button", { name: "Manage Hello (Active)" }).click();
      await page.getByRole("menuitem", { name: "Remove licence" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Remove licence" }).click();
      await card.getByRole("button", { name: "Manage Hello (Needs a licence)" }).waitFor();

      await page.getByLabel("Restore licence…").setInputFiles(file);
      await page.getByText("Licence for Hello restored").waitFor();
      await card.getByRole("button", { name: "Manage Hello (Active)" }).waitFor();
    },
    db => db.q("INSERT INTO server_settings (key, value, updated_at) VALUES ('modules.licenses', ?, ?)", JSON.stringify([license()]), Date.now()),
  ));

test("the compact layout shows small tiles, survives a reload, and a tile opens its sheet", () =>
  withStore(
    {
      items: [
        item({ hero: "STUB/img/hero.png", badge: "new" }),
        ...["one", "two", "three", "four"].map((id, i) =>
          item({ id, product: `inkledger.${id}`, name: { en: `Mod ${i + 1}`, it: `Mod ${i + 1}` }, mode: i % 2 ? "paid" : "request" }),
        ),
      ],
    },
    async ({ page }) => {
      const list = page.locator("[data-store-layout]");
      assert.equal(await list.getAttribute("data-store-layout"), "large");
      await page.getByRole("radio", { name: "Compact" }).click();
      assert.equal(await list.getAttribute("data-store-layout"), "compact");
      // Four tiles to a row on a wide window, so a tile is well under half the list's width.
      const listBox = await list.boundingBox();
      const tileBox = await page.locator('[data-store-item="hello"]').boundingBox();
      assert.ok(tileBox && listBox && tileBox.width < listBox.width / 3, `tile ${tileBox?.width} of ${listBox?.width}`);
      if (process.env.E2E_SHOTS) await page.locator("#store-modules").screenshot({ path: join(process.env.E2E_SHOTS, "store-compact.png") });

      await page.reload();
      await page.locator('[data-store-item="hello"]').waitFor();
      assert.equal(await list.getAttribute("data-store-layout"), "compact");
      const tile = page.locator('[data-store-item="hello"]');
      await tile.getByRole("button", { name: "Request licence" }).waitFor();
      await page.locator('[data-store-item="two"]').getByRole("button", { name: "€2.99" }).waitFor();
      await tile.getByRole("button", { name: "Details of Hello" }).click();
      await page.getByRole("dialog").getByText("Says hello in the sidebar.").first().waitFor();
    },
  ));
