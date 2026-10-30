# inkledger add-on module terms

These terms apply to the add-on modules offered in inkledger's **Settings → Store** (for example Kanbunny). inkledger itself stays free software under the [MIT licence](../LICENSE); the modules are separate, closed-source works.

## 1. Licence
- A module licence lets a few inkledger servers you run (three, unless the store says otherwise for a module) run the module for **everyone who uses those servers**. It does not expire.
- Each server activates the licence with the store, which counts the servers; the activation renews by itself every few months. To move to another server, free the old one from Settings → Store (or, without it, ask for a reset by opening an issue). A server that can't reach the store keeps working 30 days past its activation.
- You may keep a copy of your licence file and restore it on a server you run, for example after moving to a new machine.
- You may not copy, resell, share, decompile or modify the module files, or publish your licence.

## 2. Free releases
- Some modules are offered for free on request, often as a beta. A free licence is given at the developer's discretion and may be declined.
- A free release may change, gain features or end; licences already issued keep working with the version you have installed.

## 3. Payments and refunds
- Paid modules are sold through Lemon Squeezy, which acts as the merchant of record and handles payment, taxes and receipts. Their [buyer terms](https://www.lemonsqueezy.com/buyer-terms) and refund policy apply.
- Payments in bitcoin, when offered, are final once confirmed.
- A fingerprint of every licence (a SHA-256 of its text, never your email or any other data) is written to the Bitcoin blockchain through public OpenTimestamps servers, so anyone can check when it was issued. The proof is kept by the store and can be downloaded from Settings → Store (`.ots`).

## 4. Privacy
- To issue a licence the store needs an email address. A licence request becomes a private message to the developer; the licence itself holds only a salted hash of the email, never the email.
- "Verify" on a licence asks a public Bitcoin explorer (blockstream.info unless your server sets another) about one block; nothing about you or your licence is sent.
- Modules run inside your own inkledger: they send nothing to the developer and have no tracking. Your inkledger server talks to the store only to show the catalog, to request a licence or a payment, to download a module you hold a licence for, and to activate a licence: then it sends the licence and a random identifier of the server (from a key made on the server, never the server's address, data or users). The store keeps, per licence, the identifiers of the servers it is active on and when.

## 5. No warranty
Modules are provided "as is", without warranty of any kind. To the extent the law allows, the developer is not liable for any damage arising from their use. Every module can be turned off at once from Settings → Store.

## 6. Changes
These terms may be updated; the version in this repository applies to licences issued after the change. The fingerprint on Bitcoin (§3, added on 30 October 2026) also applies to licences issued before it: it reveals nothing about you.

Questions: open an issue in this repository.
