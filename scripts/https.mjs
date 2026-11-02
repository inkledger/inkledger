#!/usr/bin/env node
// HTTPS on this machine and the local network, in front of the server (docs/https.md):
// a local CA and a certificate, and a proxy to it. The Outlook add-in needs it
// (docs/outlook.md), and so does any page opened from another device over https.
//
//   node scripts/https.mjs cert     a local CA and a certificate for this Mac (once)
//   node scripts/https.mjs serve    HTTPS on :3443 in front of the server (dev :3000)
//   node scripts/https.mjs agent    the same, started at login and kept running (macOS LaunchAgent)
//   node scripts/https.mjs agent-remove
//   node scripts/https.mjs dev      the build served on :4173 with the dev configuration, and
//                                   `serve --lan` in front of it (`pnpm dev:https`; --app-port, --no-build)
//
// Options for serve: --port 3443, --target http://127.0.0.1:3000, --lan (listen
// on every interface, not only this machine). The files live in data/https
// (gitignored). Trusting the CA is a step done by hand: this script prints it.
// More names for the certificate (a network name, an IPv4 address): HTTPS_NAMES in
// .env, comma-separated, or `cert --name <name>` (repeatable).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { request } from "node:http";
import { connect } from "node:net";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

config({ quiet: true });

const DIR = resolve("data/https");
// Made before HTTPS was more than the Outlook add-in's: the same CA, kept where it is now.
const LEGACY_DIR = resolve("data/outlook-https");
if (!existsSync(DIR) && existsSync(LEGACY_DIR)) renameSync(LEGACY_DIR, DIR);
const file = name => join(DIR, name);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/** The names this machine answers to: localhost, its own .local name, and HTTPS_NAMES / --name. */
function names() {
  const full = hostname().toLowerCase().replace(/\.local$/, "");
  const short = full.split(".")[0];
  const extra = (process.env.HTTPS_NAMES ?? "").split(",").map(n => n.trim().toLowerCase()).filter(Boolean);
  const given = process.argv.flatMap((a, i) => (a === "--name" && process.argv[i + 1] ? [process.argv[i + 1].toLowerCase()] : []));
  return [...new Set(["localhost", `${short}.local`, short, full, ...extra, ...given])];
}

const isIPv4 = name => /^\d{1,3}(\.\d{1,3}){3}$/.test(name);
const san = name => (isIPv4(name) ? `IP:${name}` : `DNS:${name}`);

/** Names the certificate doesn't cover yet (made before they were added). */
function uncovered() {
  const text = execFileSync("openssl", ["x509", "-in", file("server.crt"), "-noout", "-ext", "subjectAltName"], { encoding: "utf8" });
  const have = new Set(text.replace(/IP Address:/g, "IP:").toLowerCase().split(/[,\s]+/));
  return names().filter(n => !have.has(san(n).toLowerCase()));
}

function openssl(...args) {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "inherit"] });
}

function makeCert() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(file("ca.crt"))) {
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825",
      "-keyout", file("ca.key"), "-out", file("ca.crt"), "-subj", "/CN=inkledger local CA");
  }
  const sans = [...names().map(san), "IP:127.0.0.1"].join(",");
  writeFileSync(file("server.ext"), `subjectAltName=${sans}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n`);
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", file("server.key"),
    "-out", file("server.csr"), "-subj", `/CN=${names()[1]}`);
  openssl("x509", "-req", "-in", file("server.csr"), "-CA", file("ca.crt"), "-CAkey", file("ca.key"),
    "-CAcreateserial", "-days", "397", "-sha256", "-extfile", file("server.ext"), "-out", file("server.crt"));
  console.log(`Certificate for ${names().join(", ")} in ${DIR}.`);
  console.log("\nTrust the local CA once (asks for your password), then restart the browser (and Outlook):\n");
  console.log(`  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${file("ca.crt")}"\n`);
}

function serve(lan = process.argv.includes("--lan"), to = arg("target", "http://127.0.0.1:3000")) {
  if (!existsSync(file("server.crt"))) {
    console.error("No certificate yet: run `node scripts/https.mjs cert` first.");
    process.exit(1);
  }
  const missing = uncovered();
  if (missing.length) console.warn(`The certificate doesn't cover ${missing.join(", ")}: run \`node scripts/https.mjs cert\` again.`);
  const port = Number(arg("port", "3443"));
  const target = new URL(to);
  const host = lan ? "0.0.0.0" : "127.0.0.1";
  const server = createServer({ key: readFileSync(file("server.key")), cert: readFileSync(file("server.crt")) }, (req, res) => {
    // The Host stays as asked: the server builds the add-in's links from it, and checks Origin against it.
    const upstream = request(
      { hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, "x-forwarded-proto": "https" } },
      answer => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", e => {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`inkledger is not answering on ${target.origin}: ${e.message}`);
    });
    req.pipe(upstream);
  });
  // WebSockets too (the dev server's live reload): the pane must not lose its server inside Outlook.
  server.on("upgrade", (req, socket, head) => {
    const upstream = request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers });
    upstream.on("upgrade", (res, upstreamSocket, upstreamHead) => {
      const headers = Object.entries(res.headers).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(x => `${k}: ${x}`));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => socket.destroy());
    });
    upstream.on("response", res => {
      socket.end(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n\r\n`);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  server.listen(port, host, () => {
    const shown = lan ? names().filter(n => n.includes(".")) : ["localhost"];
    for (const name of shown) console.log(`HTTPS on https://${name}:${port}/ → ${target.origin}`);
    console.log(`Add-in manifest: https://${shown[0]}:${port}/api/outlook/manifest.xml`);
  });
}

/** Something listens on this port of this machine. */
function answers(port) {
  return new Promise(done => {
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      done(true);
    });
    socket.on("error", () => done(false));
  });
}

/**
 * For people on other machines: the build (`pnpm dev:build`: the .env database, no
 * live reload, nothing moves while vite on :3000 is being edited) on its own port,
 * and HTTPS in front of it, on the local network. Ctrl-C stops both.
 */
async function dev() {
  const port = arg("app-port", "4173");
  const script = process.argv.includes("--no-build") ? ["exec", "tsx", "api/boot.ts"] : ["dev:build"];
  // Same database as the dev server: when that runs, it alone syncs the trackers
  // (two schedulers would ask Jira twice as often, and Jira Server locks accounts).
  const devRunning = await answers(3000);
  if (devRunning) console.log("The dev server on :3000 is running: it syncs the trackers, this server doesn't.");
  // A process group of its own: pnpm doesn't pass a signal on to the server it runs, the group gets it.
  const app = spawn("pnpm", script, {
    stdio: "inherit",
    detached: true,
    env: { ...process.env, PORT: port, SERVE_BUILD: "1", ...(devRunning ? { SYNC_INTERVAL_MIN: "0" } : {}) },
  });
  app.on("exit", code => process.exit(code ?? 0));
  const stop = signal => {
    try {
      process.kill(-app.pid, signal);
    } catch {
      process.exit(0);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop(signal));
  process.on("exit", () => stop("SIGTERM"));
  serve(true, `http://127.0.0.1:${port}`);
  const shown = names().filter(n => n.includes("."));
  console.log(`Also over plain http: ${shown.map(n => `http://${n}:${port}/`).join(", ")} (once the build is up)`);
}

const LABEL = "dev.inkledger.https";
const PLIST = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
/** The agent's name when it served only Outlook: replaced by `agent`, removed by `agent-remove`. */
const LEGACY_PLIST = join(homedir(), "Library/LaunchAgents", "dev.inkledger.outlook-https.plist");
const xml = s => s.replace(/[<>&]/g, c => `&#${c.charCodeAt(0)};`);

/** `serve` with these options at every login, restarted if it stops (logs in data/https/proxy.log). */
function installAgent() {
  if (!existsSync(file("server.crt"))) {
    console.error("No certificate yet: run `node scripts/https.mjs cert` first.");
    process.exit(1);
  }
  const args = [process.execPath, fileURLToPath(import.meta.url), "serve", ...process.argv.slice(3)];
  mkdirSync(join(homedir(), "Library/LaunchAgents"), { recursive: true });
  writeFileSync(
    PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(process.cwd())}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(file("proxy.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(file("proxy.log"))}</string>
</dict></plist>
`,
  );
  const domain = `gui/${process.getuid()}`;
  for (const plist of [PLIST, LEGACY_PLIST]) {
    try {
      execFileSync("launchctl", ["bootout", domain, plist], { stdio: "ignore" });
    } catch {
      // not loaded yet
    }
  }
  rmSync(LEGACY_PLIST, { force: true });
  execFileSync("launchctl", ["bootstrap", domain, PLIST], { stdio: "inherit" });
  console.log(`HTTPS now starts at login (${PLIST}). Remove it with: node scripts/https.mjs agent-remove`);
}

function removeAgent() {
  for (const plist of [PLIST, LEGACY_PLIST]) {
    try {
      execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, plist], { stdio: "ignore" });
    } catch {
      // not loaded
    }
    rmSync(plist, { force: true });
  }
  console.log("HTTPS no longer starts at login.");
}

const command = process.argv[2];
if (command === "cert") makeCert();
else if (command === "serve") serve();
else if (command === "agent") installAgent();
else if (command === "agent-remove") removeAgent();
else if (command === "dev") await dev();
else {
  console.error("Usage: node scripts/https.mjs cert [--name <name>] | serve | agent [--port 3443] [--target http://127.0.0.1:3000] [--lan] | agent-remove | dev [--app-port 4173] [--no-build]");
  process.exit(1);
}
