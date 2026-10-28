#!/usr/bin/env node
// HTTPS on the local network for the Outlook add-in (docs/outlook.md): Outlook
// loads add-ins only over HTTPS with a certificate it trusts.
//
//   node scripts/outlook-https.mjs cert     a local CA and a certificate for this Mac (once)
//   node scripts/outlook-https.mjs serve    HTTPS on :3443 in front of the server (dev :3000)
//   node scripts/outlook-https.mjs agent    the same, started at login and kept running (macOS LaunchAgent)
//   node scripts/outlook-https.mjs agent-remove
//
// Options for serve: --port 3443, --target http://127.0.0.1:3000, --lan (listen
// on every interface, not only this machine). The files live in data/outlook-https
// (gitignored). Trusting the CA is a step done by hand: this script prints it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { request } from "node:http";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = resolve("data/outlook-https");
const file = name => join(DIR, name);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/** The names this machine answers to: localhost and its own .local name. */
function names() {
  const short = hostname().replace(/\.local$/i, "");
  return ["localhost", `${short}.local`, short];
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
  const san = [...names().map(n => `DNS:${n}`), "IP:127.0.0.1"].join(",");
  writeFileSync(file("server.ext"), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n`);
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", file("server.key"),
    "-out", file("server.csr"), "-subj", `/CN=${names()[1]}`);
  openssl("x509", "-req", "-in", file("server.csr"), "-CA", file("ca.crt"), "-CAkey", file("ca.key"),
    "-CAcreateserial", "-days", "397", "-sha256", "-extfile", file("server.ext"), "-out", file("server.crt"));
  console.log(`Certificate for ${names().join(", ")} in ${DIR}.`);
  console.log("\nTrust the local CA once (asks for your password), then restart Outlook:\n");
  console.log(`  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${file("ca.crt")}"\n`);
}

function serve() {
  if (!existsSync(file("server.crt"))) {
    console.error("No certificate yet: run `node scripts/outlook-https.mjs cert` first.");
    process.exit(1);
  }
  const port = Number(arg("port", "3443"));
  const target = new URL(arg("target", "http://127.0.0.1:3000"));
  const host = process.argv.includes("--lan") ? "0.0.0.0" : "127.0.0.1";
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
    const name = host === "0.0.0.0" ? names()[1] : "localhost";
    console.log(`HTTPS on https://${name}:${port}/ → ${target.origin}`);
    console.log(`Add-in manifest: https://${name}:${port}/api/outlook/manifest.xml`);
  });
}

const LABEL = "dev.inkledger.outlook-https";
const PLIST = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const xml = s => s.replace(/[<>&]/g, c => `&#${c.charCodeAt(0)};`);

/** `serve` with these options at every login, restarted if it stops (logs in data/outlook-https/proxy.log). */
function installAgent() {
  if (!existsSync(file("server.crt"))) {
    console.error("No certificate yet: run `node scripts/outlook-https.mjs cert` first.");
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
  try {
    execFileSync("launchctl", ["bootout", domain, PLIST], { stdio: "ignore" });
  } catch {
    // not loaded yet
  }
  execFileSync("launchctl", ["bootstrap", domain, PLIST], { stdio: "inherit" });
  console.log(`HTTPS for Outlook now starts at login (${PLIST}). Remove it with: node scripts/outlook-https.mjs agent-remove`);
}

function removeAgent() {
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, PLIST], { stdio: "ignore" });
  } catch {
    // not loaded
  }
  rmSync(PLIST, { force: true });
  console.log("HTTPS for Outlook no longer starts at login.");
}

const command = process.argv[2];
if (command === "cert") makeCert();
else if (command === "serve") serve();
else if (command === "agent") installAgent();
else if (command === "agent-remove") removeAgent();
else {
  console.error("Usage: node scripts/outlook-https.mjs cert | serve | agent [--port 3443] [--target http://127.0.0.1:3000] [--lan] | agent-remove");
  process.exit(1);
}
