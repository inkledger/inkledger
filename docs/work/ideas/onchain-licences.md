# Spec: module purchases provable on Bitcoin (#2)

Status: planned 2026-10-29, not started. Open questions are asked when their batch is reached (README, R-0.12).


## Verified facts
- **Licence format.** The envelope is `base64url(payload).base64url(sig)`, Ed25519 over the context plus the raw bytes (`seal/src/envelope.ts:13-36`). Payload `{id,email_hash,product,issued,v:1}` is built in `seal/src/lines.ts:32-40`, hard-coded with no hook.
- **The app verifier.** `licensePayloadSchema` is a plain `z.object` (`contracts/modulesSchema.ts:22`), so **unknown fields are dropped**. A `v > 1` is refused as `future-version` (`api/modules/registry.ts:127-140`).
- **Worker.**
  - `fulfilOrder` runs in the `Ledger` DO (`worker.ts:1099`).
  - The BTCPay webhook works (:530), **but** `checkout()` answers 409 to bitcoin (:451), and the claim token is never tied to a BTCPay order.
  - Tests are `node:test` with fake DOs (`store/test/support.ts`).
- **Where the licences are shown:** `ManageBadge.tsx:157-167` and `ProductSheet.tsx:212-224` (`LicenceInfo`).

## Requirements
- **R-4.1** No change MAY raise `v` or invalidate an issued licence. Any new field inside the payload MUST be optional and come with `v:1`.
  - Test: a licence carrying `holder` installs on the current app.
- **R-4.2 (OTS)** Every licence issued (Worker paid, Worker inbox `resolve` :432, CLI `sign-license`) MUST be stamped.
  - The digest is `sha256(utf8(licence text))`.
  - It is sent to ≥ 2 calendars: `https://a.pool.opentimestamps.org`, `https://b.pool.opentimestamps.org`, and `https://finney.calendar.eternitywall.com` as a fallback.
- **R-4.3** The proof MUST live **outside** the licence: Worker KV `ots:<licenceId>` = `{digest, ots: base64, status: "pending"|"complete", block?: number, time?: number}`.
- **R-4.4** A Worker cron (`[triggers] crons = ["17 * * * *"]`) MUST upgrade pending proofs, at most 100 per run, until each is `complete`.
- **R-4.5** `GET /ots/<licenceId>` MUST return `{status, block, time}` + `ots` (base64). It is public: it contains only hashes.
- **R-4.6** The app MUST verify the proof locally:
  - recompute the digest;
  - parse the `.ots` with the `opentimestamps` package (0.4.x);
  - check the block's merkle root against an explorer (`OTS_EXPLORER`, default `https://blockstream.info/api`).
  - Without a network: status `unverified`, never `failed`.
- **R-4.7 (wallet, opt-in)** At checkout or claim the buyer MAY give a Bitcoin address plus a BIP-322 signature of `inkledger licence\nproduct: <product>\nclaim: <token>`.
  - The Worker verifies it before signing and adds `holder: {chain:"btc", address}` to the payload (`v:1`).
- **R-4.8** `POST /claim/wallet {product, address, nonce, signature}`:
  - the nonce is issued by `GET /claim/wallet/nonce` (5 min, single use, a DO);
  - it returns the licence whose `holder.address` matches;
  - a wrong signature gives 403, rate-limited like `BRAKED` (:999).
- **R-4.9** "Prove it's yours" in the app: a challenge `inkledger proof\nlicence: <id>\nnonce: <random>` is shown; the user signs it with their wallet and pastes the signature; it is verified locally.
- **R-4.10 (BTCPay)**:
  - `checkout(method:"bitcoin")` creates an invoice through Greenfield `POST /api/v1/stores/{storeId}/invoices` with `{amount, currency:"EUR", metadata:{itemCode, buyerEmail, claimToken}, checkout:{redirectURL}}` and returns `checkoutLink`;
  - the webhook writes `claim:<token>.order = "btc:<invoice>"`, as LS does (:519-524);
  - new catalog field `checkout.btcpay: {url, storeId}` (Worker type :131, plus `contracts/storeSchema.ts:16`);
  - new secret `BTCPAY_API_KEY`.
- **R-4.11** `docs/modules-terms.md`:
  - §3 gains a line on OTS ("a fingerprint of your licence, never your data, is written to Bitcoin") and on BTC (final, Lightning);
  - §4 covers the wallet address inside the licence and the explorer contacted on "Verify".
- **R-4.12** Backfill: an admin endpoint (`ADMIN_SECRET`) stamps every licence already in `ORDERS`. The UI then says "existed by {date}" (with no `issued` claim).

## Decisions
- **D-4.1** OTS rather than a custom transaction or an NFT.
  - *Why:* free, no wallet of ours, only hashes on-chain, an open standard that anyone can verify.
- **D-4.2** The proof sits outside the licence.
  - *Why:* the signature covers the bytes; the proof arrives hours later.
- **D-4.3** NFT **excluded**.
  - *Why:* fees, tax and legal issues, speculation, a conflict with "licence forever, no grants", and offline verification would be lost.
- **D-4.4** BTC only. EVM/SIWE is in Q2.

## App API (`api/routers/modules.ts`)
```ts
licenceProof: protectedProcedure.input(z.object({ id: z.string().min(1).max(64) }))
  // → { status: "none"|"pending"|"complete"|"verified"|"unverified"|"failed", block: number|null, time: number|null, existedBy: boolean }
licenceProofFile: protectedProcedure.input(z.object({ id: z.string().min(1).max(64) }))  // → { filename: `${id}.ots`, base64 }
proveHolder: protectedProcedure.input(z.object({ id: z.string().min(1).max(64), nonce: z.string().length(32), signature: z.string().min(1).max(2000) }))
  // → { ok: boolean }
```
- `modules.list` (`:145-159`) gains `holder: {chain, address} | null` for each licence.

**Errors:**
- E-4.1 `server.modules.proof.none` (NOT_FOUND)
- E-4.2 `server.modules.proof.mismatch` (the digest does not match the licence)
- E-4.3 `server.modules.holder.none`
- E-4.4 `server.modules.holder.badSignature`

## UI
- `LicenceInfo` and `ManageBadge`: a line `Chip` showing the state:
  - pending: "Being anchored on Bitcoin";
  - complete/verified: "On Bitcoin since {date} · block {block}", with "Verify" and "Download .ots" buttons;
  - unverified: "Proof saved, verification needs the network";
  - failed: `danger`, "The proof doesn't match".
- With `holder`: "Tied to {address, shortened}", and "Prove it's yours", which opens a `Dialog` with the challenge, a `CopyButton` and a field for the signature.
- `PayPanel` (`panels.tsx:135`): when `methods.bitcoin === "on"` and `checkout.btcpay` is present, the bitcoin radio is active, with an optional "Bitcoin address to tie the licence to" and a field for the signature.

**i18n** (en / it):

| Key | en | it |
|---|---|---|
| `ui.store.proof.pending` | Being anchored on Bitcoin | In ancoraggio su Bitcoin |
| `ui.store.proof.done` | On Bitcoin since {date} · block {block} | Su Bitcoin dal {date} · blocco {block} |
| `ui.store.proof.existedBy` | Existed by {date} (proof added later) | Esisteva già il {date} (prova aggiunta dopo) |
| `ui.store.proof.verify` / `download` | Verify / Download .ots | Verifica / Scarica .ots |
| `ui.store.proof.offline` | Proof saved; checking needs the network | Prova salvata; per verificarla serve la rete |
| `ui.store.proof.failed` | The proof doesn't match this licence | La prova non corrisponde a questa licenza |
| `ui.store.holder.tied` | Tied to {address} | Legata a {address} |
| `ui.store.holder.prove` | Prove it's yours | Dimostra che è tua |
| `ui.store.holder.ok` / `bad` | Signature matches / Signature doesn't match | La firma corrisponde / La firma non corrisponde |

## AC → test

| AC | Given / When / Then | Test |
|---|---|---|
| AC-4.1 | a licence with an extra field `holder`, v:1, signed with the test key · `verifyLicense` ok | `api/modules/modules.test.ts` "a licence with a wallet still installs" |
| AC-4.2 | fulfil paid · KV `ots:<id>` pending, 2 calendars called with the right digest | `store/test/ots.test.ts` "every issued licence is stamped" |
| AC-4.3 | fake calendar complete after 2 runs · status complete with block | same, "pending proofs are upgraded hourly" |
| AC-4.4 | inbox resolve · stamped | same, "free licences are stamped too" |
| AC-4.5 | real `.ots` fixture (OTS repo `hello-world.txt`) + fake explorer · verified; explorer down · unverified; another digest · failed | `api/modules/proof.test.ts` "a proof verifies against Bitcoin, offline stays unverified" |
| AC-4.6 | BIP-322 vectors from the BIP · valid ok, altered no | `store/test/wallet.test.ts` "wallet signatures follow BIP-322" |
| AC-4.7 | claim/wallet nonce reused · 403; expired · 403; right · licence | same, "a wallet recovers its licence once per nonce" |
| AC-4.8 | checkout bitcoin with fake Greenfield · link; webhook settled · `/claim/<token>` paid | `store/test/btcpay.test.ts` "bitcoin checkout ends in a claimable licence" |
| AC-4.9 | Store UI · badges in the 5 states | `e2e/store.test.mjs` "a licence shows its Bitcoin proof" |
| AC-4.10 | Prove: right signature (vector) · ok; wrong · bad | same, "a tied licence can prove its holder" |
| AC-4.11 | `seal sign-license` with a fake calendar · the stamp is sent with the licence's sha256 | `seal/test` "a licence signed by hand is stamped too" |
| AC-4.12 | `GET /ots/<id>` pending, complete, unknown · status and proof; 404 | `store/test/ots.test.ts` "a proof can be fetched by licence" |
| AC-4.13 | checkout with a valid BIP-322 signature · licence has `holder`; with a bad one · refused before any signing | `store/test/wallet.test.ts` "only a signed wallet is tied to a licence" |
| AC-4.14 | the terms page · mentions the fingerprint on Bitcoin and the wallet address in the licence | `store/test/docs.test.ts` "the terms say what goes on Bitcoin" |
| AC-4.15 | 3 stored licences · backfill with `ADMIN_SECRET` · 3 stamps, a second run 0; without the secret · 403 | `store/test/ots.test.ts` "licences issued before are stamped once" |

## Traceability (every R has its ACs)

| R | AC |
| --- | --- |
| R-4.1 | AC-4.1 |
| R-4.2 | AC-4.2, AC-4.4, AC-4.11 |
| R-4.3 | AC-4.2 |
| R-4.4 | AC-4.3 |
| R-4.5 | AC-4.12 |
| R-4.6 | AC-4.5, AC-4.9 |
| R-4.7 | AC-4.6, AC-4.13 |
| R-4.8 | AC-4.7 |
| R-4.9 | AC-4.10 |
| R-4.10 | AC-4.8 |
| R-4.11 | AC-4.14 |
| R-4.12 | AC-4.15 |

## Edge cases
- A calendar down → the other one is enough, and stamping MUST NOT block issuance (it goes through `ctx.waitUntil`).
- A licence re-signed by `fulfil` (deterministic Ed25519) → same digest, the stamp is not duplicated.
- An address in a format that is not supported (P2PK, legacy multisig) → E-4.4, with "use a bc1 address".
- Bitcoin reorg → the proof is upgraded again in the next cron run (until `complete` with ≥ 6 confirmations).

## Batches
1. Worker: OTS stamp + cron + `/ots` + backfill; seal CLI `ots-stamp`. AC-4.2–4.4. *(repo `inkledger-modules` and `seal`; local commits only, never `wrangler deploy`)*
2. App: `licenceProof`, file, badge, Verify. AC-4.1, 4.5, 4.9.
3. BTCPay checkout end to end. AC-4.8 (after Q1).
4. Wallet: binding, `/claim/wallet`, Prove. AC-4.6, 4.7, 4.10 (after Q2, Q3).
5. Terms + docs. R-4.11.

### Batch 1 decisions (2026-10-30, to review)
- **No `opentimestamps` package** (user's choice: it is LGPL-3.0, unmaintained since 2022, pulls `bitcore-lib` and the deprecated `request`, and doesn't run in a Worker). Our own reader/writer of `.ots`, no dependencies: `contracts/ots.ts` in the app, the same code in the Worker's `store/src/ots.ts` (keep them in step). It follows python-opentimestamps' format and serialization order; hashes through WebCrypto, plus a pure RIPEMD-160 (older proofs start with it; WebCrypto has none). Checked on the official `hello-world.txt.ots`: read and written back byte for byte, its operations reach the real merkle root of Bitcoin block 358391 (read once from blockstream.info, kept as a fixture).
- The Worker stamps a licence when issued (the paid order's Ledger, the inbox's approval), after the answer (`ctx.waitUntil`), idempotent on the licence's SHA-256. Calendars come from `OTS_CALENDARS` (wrangler.toml: a.pool, b.pool, finney as the stand-in): **unset, nothing is stamped**, so no test ever reaches them. (The first full run of the modules tests, before this gate, may have sent the hashes of a few test licences to the public calendars: hashes only.) Every calendar down: the licence is issued unstamped, the backfill catches it.
- KV: `ots:<id>` = `{ digest, ots, status, block?, backfilled? }` and a marker `otsp:<id>` while pending; the hourly cron (`17 * * * *`) lists `otsp:` (100 a run), asks only our calendars for each pending attestation's upgrade, merges it at its place in the tree, and marks the proof complete with the lowest Bitcoin block. `time` isn't stored: the app reads it from the explorer when it verifies. `GET /ots/<id>` is public; `POST /admin/ots-backfill` (`ADMIN_SECRET`) stamps the orders' and the inbox's licences not stamped yet, `backfilled: true`, a page at a time (cursor). The KV type gained `list` and `delete` (the tests' fakes too).

- The CLI's `sign-license` licences (signed by hand, outside the store) are stamped by `seal ots-stamp --line inkledger <licence>`: it checks the licence with the line's key, then sends it to the store's `POST /admin/ots-stamp` (`SEAL_STORE_URL`, `SEAL_ADMIN_SECRET`), which stamps it only if a trusted key signed it. One place keeps every proof (the store), the app finds it there. The CLI reaches the store only when the publisher runs it.

### Batch 2 decisions (2026-10-30, to review)
- `api/modules/proof.ts`: the proof from `GET /ots/<id>` is kept on the server (`server_settings` `licence-proofs`), so it shows offline. Verified here: the licence's SHA-256 must be the proof's digest; the earliest Bitcoin attestation's message must be that block's merkle root from `OTS_EXPLORER` (`/block-height/<h>`, `/block/<hash>`, plain fetch with a timeout, `redirect: "error"`). States: `none` (not stamped), `pending` (no Bitcoin attestation in the proof, whatever the store's label), `verified` (with block and time), `unverified` (explorer or store out of reach), `failed` (another digest, or a root that doesn't match). `complete` is never answered (the app always verifies). `existedBy` = the store's `backfilled`.
- `licenceProof` / `licenceProofFile` are open to any signed-in user (the licences list is), NOT_FOUND for a licence not held here.
- Strings under `settings.store.proof.*` (the store's UI lives in Settings), plus `checking`; the badge's menu shows the one line, the product sheet the line, "Verify" (asks again) and "Download .ots".

## Open questions
- **Q1, blocks 3:** BTCPay hosting and the Lightning node. **Answer 2026-10-30: postponed:** batch 3 waits until the user has a BTCPay; the rest goes on.
- **Q2, blocks 4:** BTC only (default) or EVM too. **Answer 2026-10-30: BTC only.**
- **Explorer default, 2026-10-30:** `OTS_EXPLORER` = `https://blockstream.info/api`, confirmed.
- **Q5, B4.5, 2026-10-30:** licences issued before the terms mention the fingerprint: stamp them too (the backfill)? **Answer: yes**, and §6 says so (only hashes, nothing personal).
- **Q3, blocks 4:** a BIP-322 library compatible with Workers (bundle size, no Node APIs). If none fits, verify on the app side and have the Worker trust a token. **Answer 2026-10-30:** evaluate the libraries (size, Workers compatibility) and come back with a concrete choice before adding any dependency.
- **Q4, not blocking:** taxation of BTC sales (VAT number from Jan 2027). The doc only notes it.

---
