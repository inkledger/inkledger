# Native app (Tauri): desktop and mobile

The native app is a **shell** around the server: the window (Mac, Windows, iPhone, Android)
opens the existing server (the container) and adds system features (menu bar timer,
notifications, global shortcuts, idle detection, launch at login). There is one backend and one
database, so the browser, the Mac and the phone always see the same data.

```
 native app / browser ──https──▶ tailscale serve (Mac) ──▶ container 127.0.0.1:47823 ──▶ Jira
```

## 1. Make the server reachable (Tailscale)

The container stays on `127.0.0.1`: no port is open to the Internet. Tailscale publishes it
only inside your private network (tailnet), with automatic HTTPS. Each server of the Mac is
published on its own HTTPS port, the same as its local port (`:47823` for the container,
`:3000` for dev), so the addresses never clash and a local web server on 443 can't shadow them.

1. Install Tailscale on the Mac and on the phones, signed in to the same account.
2. On the Mac, enable HTTPS in the tailnet (admin console → DNS → HTTPS certificates). Then
   either click **Use Tailscale** in the desktop app (Settings → Devices) or run:
   ```sh
   tailscale serve --bg --https=47823 http://127.0.0.1:47823
   tailscale serve status        # shows https://my-mac.<tailnet>.ts.net:47823
   ```
3. In `.env.docker` add the published name and trust the proxy, then restart:
   ```sh
   ALLOWED_HOSTS=my-mac.<tailnet>.ts.net,localhost,127.0.0.1
   TRUST_PROXY=1
   ```
   ```sh
   docker compose up -d
   ```
4. From the phone (Tailscale on), check in the browser: `https://my-mac.<tailnet>.ts.net:47823`
   should show the login page and work.
5. Check that the session cookie is `Secure`:
   ```sh
   curl -s -o /dev/null -D - https://my-mac.<tailnet>.ts.net:47823/api/health
   ```
   If after login (DevTools → Application → Cookies) the `ikl_session_47823` cookie is not *Secure*, the proxy
   isn't sending `X-Forwarded-Proto`: add `COOKIE_SECURE=1` to `.env.docker`. Use it **only** if
   you always connect over HTTPS: on `http://127.0.0.1:47823` a Secure cookie may not be sent
   back to the server (browser dependent).

Already handled by the server:
- `ALLOWED_HOSTS` accepts the tailnet name (otherwise it answers 421).
- The CSRF check compares Origin and Host: `tailscale serve` preserves the original Host, so
  writes go through.
- The CSP allows Tauri's native channel (`connect-src … ipc: http://ipc.localhost`).

## 2. Desktop app (development)

```sh
pnpm tauri:dev        # opens the app; on first launch it asks for the server address
pnpm tauri:build      # .app and .dmg in src-tauri/target/release/bundle/
```

To hand the apps out, `pnpm dist` builds them in release mode and collects them in
`release/<version>/` (gitignored) with `SHA256SUMS` and a `manifest.json` (sizes, commit, build
times). The version is `tauri.conf.json`'s.

```sh
pnpm dist             # macOS (.dmg + .app.zip, arm64) and Android (.apk, also published to the container)
pnpm dist --mac       # macOS only
pnpm dist --android   # Android only (runs pnpm native:publish)
```

A version tag matching `package.json` (`v1.2.3` for version `1.2.3`) also builds a macOS
`.dmg` and a Windows NSIS `.exe` on their native GitHub runners. Once all checks and builds
pass, CI attaches both installers and their SHA-256 checksums to the GitHub Release.

- **Unsigned:** macOS asks to confirm the first launch (right click → Open), Windows may show
  SmartScreen, and the APK is signed with the debug key. Desktop signing/notarization is not
  configured yet.
- **Source:** the script refuses uncommitted changes unless given `--allow-dirty`. Each file
  in `manifest.json` names its own commit and whether the tree was dirty. The release-wide
  `commit` is set only when all files agree, and the script warns when they don't (e.g. an APK
  left from an earlier build).
- **Never stale:** the previous `.app`/`.dmg` are removed before the build. A build that
  fails before making the `.app` fails the script, and an APK older than this run is refused.
- **The .dmg** is made by Tauri, which drives Finder; when that step fails (headless, Finder
  automation denied) the script makes a plain compressed image of the .app with `hdiutil`.

- **Profiles:** each server (e.g. `localhost:3000`, `localhost:47823`,
  `my-mac.<tailnet>.ts.net:47823`) is a profile with its own Jira and user. Add them from
  Settings → Server; switch between them from the **Server** menu (app and menu bar), the
  account menu, or Settings → Server. Each server has its own session cookie (the name
  includes the port, e.g. `ikl_session_47823`), so two servers on the same host don't sign each other out.
- **Sign out and disconnect** ends the session on that server and removes only that profile.
- **Permissions:** Settings → Permissions shows the state of notifications, launch at login,
  shortcuts, idle detection and Full immersion, with a button that opens the right System
  Settings pane and a per-platform guide. On macOS apps can't read the notification state:
  the test button sends a test notification.
- Links to other sites (Jira) open in the system browser.
- The window opens maximized; closing it leaves inkledger in the menu bar (click the Dock icon or
  press ⌥⇧J to reopen it, "Quit inkledger" in the menu to exit).
- **Menu bar:** the running timer (h:mm, ❚❚ when paused) with Pause/Resume, Stop and log…,
  Start timer…
- **Global shortcuts:** ⌥⇧T starts a timer, ⌥⇧P pauses/resumes, ⌥⇧J shows inkledger.
- **Notifications:** timer reminders, Jira notifications and end of day arrive in the
  Notification Center.
- **Idle:** the system reports no input, screen lock and sleep; on return inkledger comes to the
  front and asks what to do with the time (threshold in Settings → Timers and idle).
- **Icons:** every icon (PWA, menu bar, macOS, Android, iOS) comes from one glyph in
  `scripts/icon-glyph.mjs`; `pnpm icons` regenerates them all, outputs committed. macOS 26
  gets light, dark, clear and tinted variants from `icons/Icon.icon` (Icon Composer
  format), compiled by that script into `icons/Assets.car` with Xcode 26's `actool` and
  shipped as is (`CFBundleIconName` in `src-tauri/Info.plist`), so building the app needs
  no Xcode 26; older macOS uses `icon.icns`. Android 13+ themed icons use
  `ic_launcher_monochrome`.
- Permissions model: the local page (`capabilities/default.json`) can only connect; the server
  (`capabilities/remote.json`, only `*.ts.net` and loopback) can call the commands listed
  there. Every new command called from the page must be added to `build.rs` and to
  `remote.json` (`pnpm test:e2e` checks this).

## 3. Phones (Android and iPhone)

A phone reaches the server only through Tailscale (`https://my-mac.<tailnet>.ts.net:47823`).
In the desktop app, **Settings → Devices** shows the steps and a QR code to the public
`/install` page (no login, reachable only from the tailnet or from this Mac).

- **Android:** native app. Publish it on the server with
  ```sh
  pnpm native:publish          # build (release, arm64) + copy into the container
  pnpm native:publish --dev    # also for the dev server (data/downloads)
  pnpm native:publish --no-build
  ```
  `inkledger.apk` and `manifest.json` end up in `/app/data/downloads` (a container volume, kept
  across deploys). The container name defaults to `inkledger` (override with `INKLEDGER_CONTAINER`). On the
  phone: `/install` → "Download inkledger for Android" → install → add the server. Build
  requirements: Android Studio (SDK + NDK), JDK 17 or 21, the Android Rust target
  (`rustup target add aarch64-linux-android`). The release build is signed with the debug key:
  to update, just republish and reinstall.
- **iPhone:** web app. In Safari, `/install` → Share → "Add to Home Screen". Without an Apple
  Developer account a native app can't be distributed from a link; with one you can move to
  TestFlight or ad-hoc installs. Limitation: notifications arrive only while the app is open.

### Without Tailscale: local network (HTTPS)
In the desktop app, **Settings → Devices → Local network (no Tailscale)**: the switch shares
the open server (it must be on this Mac, e.g. `localhost:47823`) over Wi-Fi.
- The app creates a local CA ("inkledger — <Mac>") once, in its data folder, and on every launch a
  certificate for `<Mac>.local` and the Mac's current IPs.
- HTTPS proxy on `:47843` to the server; an HTTP welcome page on `:47844` with the
  certificate (`.mobileconfig` for iPhone, `.crt` for Android) and the steps to install it.
- The server accepts the new names (`.local`, private IPs) registered by the app
  (`server_hosts`).
- iPhone: after the profile, Settings → General → About → Certificate Trust Settings.
  Android: Settings → Security → Encryption & credentials → Install a certificate → CA
  certificate; the Android app trusts user-installed CAs.
- The first time, macOS asks whether to allow incoming connections to the app: Allow.
- Trusted networks only: anyone on the same Wi-Fi can see the sign-in page.

## 4. Phases

| Phase | Content | Status |
| --- | --- | --- |
| 0 | Server ready for native clients (this document) | done |
| 1 | Tauri project (`src-tauri/`), "connect to the server" screen, `src/lib/native.ts` bridge | done (desktop) |
| 2 | Desktop: menu bar timer, system notifications, global shortcuts, system idle, launch at login | done (focus mini window: to do) |
| 3 | Mobile: safe area and touch, Android app downloadable via Tailscale, iPhone web app | done |
| 4 | Build and signing (dmg, apk/aab, TestFlight) | unsigned builds done (`pnpm dist`); signing: to do |

### Prerequisites for phases 1–4
- Rust (`rustup`), Xcode, Android Studio with SDK and NDK.
- For iOS and for a signed/notarized macOS app: an Apple Developer account.
- For Android: a signing keystore.

### Known limitations
- **Push** notifications on a phone with the app closed need APNs/FCM and a sending service
  (optional later phase). Local notifications work with the app open or in the background.
- Timer widgets and Live Activities need dedicated Swift/Kotlin code (optional phase).
- Web app updates reach the native apps immediately (they load the server); the native app
  only needs updating when the shell changes.
