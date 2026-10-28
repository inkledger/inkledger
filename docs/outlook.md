# Pinning Outlook mails

You can pin a mail to an issue, a TODO or the pinboard to get back to the conversation in Outlook. inkledger keeps only the mail's headers (subject, sender, date, Message-ID) and its link. It never keeps the body.

There are three ways to pin a mail. They work alone or together.

| Way | Where it works | What it needs |
| --- | --- | --- |
| Search the mailbox ("Pin a mail…" in the palette or on an issue) | inkledger, any device | A Microsoft sign-in in Settings → Outlook, on a server with `MS_CLIENT_ID` |
| "Pin to inkledger" button | Outlook: new Outlook for Mac, Windows, the web | The add-in installed once, over HTTPS on this machine |
| Drag a mail, drop an `.eml` file, or paste an Outlook web link | inkledger | Nothing |

When you are signed in, a mail that arrives without a link (an `.eml` file) gets its link from the mailbox through its Message-ID.

## Searching the mailbox (Microsoft sign-in)

inkledger signs in with the device code flow, as it does for GitHub: you type a code at microsoft.com and nothing has to reach inkledger. It asks Graph for `Mail.Read offline_access User.Read` and reads headers only. The tokens are sealed in the database for that user (`mail_accounts`), and signing out deletes them.

Before anyone can sign in, whoever runs the server registers an app once:

1. Go to Microsoft Entra admin center → App registrations → New registration.
   - Use any name.
   - For "Accounts in this organizational directory only", pick your tenant.
   - Leave the redirect URI empty.
2. Under Authentication → Advanced settings, set **Allow public client flows** to **Yes**.
3. Under API permissions, add Microsoft Graph delegated `Mail.Read` and `User.Read` (`offline_access` is implied).
4. Put the ids in the server's `.env`:
   ```
   MS_CLIENT_ID=<Application (client) id>
   MS_TENANT=<Directory (tenant) id>   # or "organizations"
   ```
5. Restart the server, then go to Settings → Outlook → Sign in to Microsoft.

Many organizations do not let users approve `Mail.Read` for an app on their own. If yours is one of them, Microsoft shows "Need admin approval" and inkledger reports that the organization must approve the app. Ask IT to grant consent to that one app, or use the add-in, which needs no approval.

## The Outlook add-in

The add-in is a "Pin to inkledger" button on an open mail. It reads that mail's headers through Office.js with `ReadItem`: no Graph and no admin.

Its pane is a page of the app (`/outlook.html`), drawn with the same design system. In it you can:
- pin the mail to an issue, searched by key or words;
- make a new TODO about it, with no date, today, tomorrow or a day you pick;
- put it on a board of your choice, or on a new board named on the spot;
- copy its link as Markdown (`[✉ subject](link)`) to paste into a note, a TODO or a comment.

The pane also says where the mail is pinned already, with a check on those issues.

**Pin the pane** with the pin at its top. Unpinned, Outlook closes it when you select another mail. Pinned, it stays open and follows the mail you select; until it has done so once, the pane shows a reminder.

Outlook loads add-ins only over HTTPS with a trusted certificate. `scripts/outlook-https.mjs` provides that on this machine, so the tailnet is not needed:

```sh
node scripts/outlook-https.mjs cert            # once: a local CA and a certificate (data/outlook-https)
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain data/outlook-https/ca.crt   # once, by hand
node scripts/outlook-https.mjs serve           # https://localhost:3443 → dev :3000
```

To have HTTPS start by itself at every login, and come back if it stops, run this once:

```sh
node scripts/outlook-https.mjs agent           # a macOS LaunchAgent running `serve`
node scripts/outlook-https.mjs agent-remove    # to stop that
```

`serve` (and `agent`) take a few options:
- `--target http://127.0.0.1:47823` points the proxy at another server.
- `--port` changes its port.
- `--lan` listens on the local network, as `https://<this-mac>.local:3443`. Other machines must trust the CA too.

Then:

1. In Settings → Outlook, make the add-in key. Copy it: it is shown only once.
2. In Outlook on the web, go to Settings → Get add-ins → My add-ins → Add a custom add-in. Choose Add from URL and paste `https://localhost:3443/api/outlook/manifest.xml`, or choose Add from file with the manifest downloaded from Settings → Outlook. The add-in follows your mailbox, so it also appears in new Outlook for Mac.
   - After an update of the manifest (a new version), remove the add-in and add it again.
   - Pin the pane (the pin in its corner): it then follows the mail you select.
3. Open a mail and press **Pin to inkledger**. The first time, paste the key; Outlook keeps it in the add-in's roaming settings.

The key opens only `/api/outlook/*`, where the add-in can search issues and pin a mail. It cannot reach the rest of the API. Making a new key or revoking it in Settings stops the old one at once.

Some organizations block custom add-ins. If "Add a custom add-in" is missing, the search and the drop still work.

## What leaves the server

Settings → Network lists every host the server has called: trackers, Microsoft, GitHub, the weather, the module store. For each it shows what it is for, the number of calls and failures, and the last call. Only the host is kept, never what was asked or answered (`api/lib/egress.ts`, table `egress_hosts`).

The browser itself reaches only the server. The exception is the add-in's pane, which loads Office.js from Microsoft inside Outlook.

Links to Outlook mails open directly, without asking to allow the domain: inkledger made them.

## For developers

- Parsers (Outlook links, `.eml` headers, the deeplink builder): `contracts/mail.ts`.
- API: `api/routers/mails.ts`; `pinTo` saves and pins in one call.
- Microsoft sign-in and search: `api/mail/microsoft.ts`. Tests use `api/mail/simulator.ts` (`MAIL_SIMULATOR=1`), never Microsoft.
- Add-in:
  - `api/mail/addin.ts`: the manifest, the routes the key opens, the pane's headers;
  - `outlook.html` and `src/outlook/`: the pane, a page of the app's build.
- The pane's e2e (`e2e/outlook-addin.test.mjs`) plays Office.js with a stub. It also checks that nothing is wider than the pane at 320 and 480 px.
- UI:
  - `src/components/mail/` (picker, global drop and paste, issue section);
  - `src/components/settings/sections/Outlook.tsx`.
