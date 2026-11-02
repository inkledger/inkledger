# HTTPS on this machine and the local network

`scripts/https.mjs` (`pnpm https <command>`) puts HTTPS in front of the server, with a local certificate authority, so the tailnet is not needed. The Outlook add-in needs it ([outlook.md](outlook.md)), and so does any page opened from another device on the network over `https://`.

```sh
pnpm https cert            # once: a local CA and a certificate (data/https, gitignored)
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain data/https/ca.crt   # once, by hand
pnpm https serve           # https://localhost:3443 → dev :3000
```

`serve` (and `agent`) take a few options:
- `--target http://127.0.0.1:47823` points the proxy at another server.
- `--port` changes its port.
- `--lan` listens on the local network too. Other machines must trust the CA as well.

To have HTTPS start by itself at every login, and come back if it stops:

```sh
pnpm https agent           # a macOS LaunchAgent running `serve` with the same options
pnpm https agent-remove    # to stop that
```

## The certificate's names

It covers `localhost`, `127.0.0.1` and this machine's names (`<name>.local`, `<name>`, and its full host name). Add others, such as a name on the office DNS or an IPv4 address, with `HTTPS_NAMES` in `.env` (comma-separated) or `pnpm https cert --name <name>`, then run `cert` again. The CA stays the same, so nothing has to be trusted again. `serve` warns when a name in `HTTPS_NAMES` is not in the certificate yet.

## The dev server on the local network

By default the dev server listens only on this machine (`127.0.0.1`, what `tailscale serve` and the native app use). In `.env`:

```sh
DEV_HOST=0.0.0.0                          # listen on the local network too
DEV_ALLOWED_HOSTS=my-mac.example.lan      # network names it answers to (.local and .ts.net already do; IP addresses always)
HTTPS_NAMES=my-mac.example.lan,192.168.1.20
```

Then `pnpm dev` answers at `http://<name>:3000`: for you, with live reload.

**For other people on the network, `pnpm dev:https`.** It builds the app first (so it carries every change made up to that moment), serves the build with the development configuration and the `.env` database on `:4173`, and puts HTTPS in front of it on `:3443` (`serve --lan`): `https://<name>:3443`, or `http://<name>:4173`. They get the compiled, compressed app, which nothing changes while you edit on `:3000`: the vite dev server reloads every connected browser at each edit, and its hundreds of separate modules make that reload feel like a frozen page on another machine. Run it again to give them your latest changes.

- While the dev server on `:3000` runs, it alone syncs the trackers, and this server doesn't (`SYNC_INTERVAL_MIN=0`): both use the same database, and two schedulers would ask Jira twice as often.
- `--app-port <port>` changes `:4173`; `--no-build` serves the last build as it is.
- Ctrl-C stops both.

## Trusting the CA on other machines

Copy `data/https/ca.crt` (only the `.crt`, never `ca.key`):
- **Windows**: from an administrator prompt, `certutil -addstore -f Root ca.crt`, or open it → Install certificate → Local machine → Trusted Root Certification Authorities. Restart the browser.
- **macOS**: the `security add-trusted-cert` line above.
- **Phones**: Settings → Devices in the app installs a CA of its own ([native.md](native.md)).

Earlier versions kept the files in `data/outlook-https`: the script moves them to `data/https` the first time it runs.
