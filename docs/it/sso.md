# Single sign-on and SCIM

How people sign in through your identity provider, how accounts are made and turned off by it, and how the server stays reachable when the provider fails. Settings → Single sign-on (permission `manageAuth`: owners and IT admins). A provider's group map and default access can't hand out more than the person editing it holds: an IT admin can't map a group to the owner role.

## What is supported

| | |
| --- | --- |
| OpenID Connect | Authorization code flow with PKCE (S256), `state` and `nonce`. Entra ID, Google, Okta, Keycloak and any provider with a discovery document |
| SAML 2.0 | SP-initiated only (HTTP-Redirect request, HTTP-POST response). Signed assertions are required |
| Accounts at first sign-in (JIT) | Optional per provider; access from the group map |
| SCIM 2.0 | `/scim/v2/Users`, `/Groups` (teams), `/ServiceProviderConfig`, `/Schemas`, `/ResourceTypes` |
| Enforcement | Everyone signs in through the provider, except break-glass owners |

Not supported: IdP-initiated SAML (unsolicited responses are refused), encrypted SAML assertions, SAML single logout, SCIM bulk operations and sorting.

## Before you start

- **`PUBLIC_URL` must be set** to the address people reach the server at (for example `https://time.example.com`). The redirect URI, the ACS URL and the SAML entity ID are built from it, never from the request's `Host` header. Without it, single sign-on refuses to start.
- The server calls the provider (discovery, token and keys endpoints for OIDC) over **https only**, on a public or private network. Add those hosts to your firewall rules ([outbound connections](outbound.md)). SAML needs no call from the server.
- Clocks: up to 2 minutes of difference with the provider is tolerated on token and assertion times.

## Addresses to give the provider

Settings shows them per provider, with copy buttons.

| | Address |
| --- | --- |
| OIDC redirect URI | `<PUBLIC_URL>/api/sso/<id>/callback` |
| SAML ACS (Assertion Consumer Service) | `<PUBLIC_URL>/api/sso/<id>/acs` |
| SAML entity ID and SP metadata | `<PUBLIC_URL>/api/sso/<id>/metadata` (download from Settings) |
| SCIM base URL | `<PUBLIC_URL>/scim/v2` |

## Setting up a provider

**OpenID Connect.** Register a web application with the redirect URI above, then enter in Settings: the issuer (for example `https://login.microsoftonline.com/<tenant>/v2.0`), the client ID and the client secret. The secret is stored encrypted (sealed with `CREDENTIALS_KEY`, bound to the provider) and never shown again. The issuer in the discovery document must match the one entered.
- *Entra ID multi-tenant endpoints* (`/organizations`, `/common`): set the tenant ID; tokens from any other tenant (`tid`) are refused.
- *Groups in Entra ID:* a token carries at most 200 groups (overage). When people are in more, map **app roles** instead and set the groups claim to `roles`.

**SAML 2.0.** Upload the SP metadata to the provider (or enter the ACS URL and entity ID), then enter in Settings: the IdP's entity ID, its sign-in URL (HTTP-Redirect binding) and its signing certificate (PEM; several certificates may be pasted during a rollover). The provider must sign the assertion.

**Claims.** Empty fields use the usual names: `sub`, `preferred_username`, `email`, `name`, `groups` for OIDC; the NameID and the common email, name and group attribute URIs for SAML. Set the subject claim to `oid` for Entra ID if SCIM sends the object ID as `externalId`.

**Test sign-in** goes to the provider and back without signing you in, and shows who came back, whether they are linked to an account, and the access they would get.

## Accounts

- **Linked by subject, never by email.** An account belongs to the provider's stable subject (`sub`, or the NameID). An existing local account with the same address is not taken over; the new one gets its own username.
- **At first sign-in (JIT, optional):** an unknown person gets an account with no password, its access from the group map; when no group matches, the default role. The default access never includes the owner role or an owner-only permission. Only a group mapped explicitly to the owner role makes an owner.
- **Access is re-evaluated at every sign-in** for accounts made by single sign-on. Team membership follows the teams named in the map (leads set by an admin stay). The last owner (or last break-glass owner while enforcing) keeps the owner role.
- **Without JIT,** only accounts provisioned by SCIM or linked before can sign in.
- **SCIM-provisioned accounts** are linked by their `externalId` when SCIM sends one (set the provider's subject claim to the same value). One without an `externalId` is held under its SCIM `userName` and linked at its first sign-in through the same provider, by the username claim matching it, once: another provider can't claim it. Use a claim people can't change themselves (UPN, email managed by the directory).
- Accounts of the provider get **no password** here: reset, invite links and activation are refused for them.

## SCIM provisioning

Create a token in Settings (shown once; only its hash is kept), and give the provider the base URL and the token (Bearer). Tokens are per provider and can be revoked; a revoked token, or one of a provider turned off, gets 401. Calls are rate-limited per token (`RATE_LIMIT_SCIM`).

- `POST /Users` creates an account (no password, the provider's default access). `GET /Users?filter=userName eq "…"` and `externalId eq "…"` find one.
- `PATCH` (Entra ID's `Replace` with string booleans, Okta's value objects) and `PUT` update it; `active: false` turns it off and **ends its sessions and remembered devices**.
- `DELETE` never removes an account: it turns it off (erasure is a separate step).
- The **last owner can't be turned off**, nor the last break-glass owner while enforcing (400, `mutability`).
- SCIM sees only the accounts it provisioned: it can't read or change a local account.
- `/Groups` are teams: created, renamed, deleted, members added and removed. Only accounts SCIM provisioned are placed; team leads stay.

Every SCIM write is in the [audit log](audit.md) with the actor kind `scim` and the token's id.

## Enforcement and break-glass

Enforcing a provider means password sign-in is refused for everyone except **break-glass owners**: owners with a local account and a password, marked break-glass (Settings → Users, or "Keep password sign-in for me" in Settings → Single sign-on). Then:

- the sign-in page shows the provider's button and hides the password form behind "Sign in with a password (break-glass accounts)";
- remembered devices of other accounts don't resume (they go through the provider);
- invites, invite links, password resets and Jira activation are refused, except for break-glass accounts;
- enforcement is **refused while no break-glass owner exists**, and the last one can't be turned off or lose the flag while enforcing;
- turning the provider off ends enforcement.

**Last resort** (the provider is down and no break-glass password is known): on the server, `node dist/cli.js reset-password <username>` (Docker: `docker exec inkledger node dist/cli.js reset-password <username>`) prints a temporary password and makes the account local and break-glass, so it can sign in whatever enforcement says. Undo the flag in Settings → Users afterwards.

## Security notes

- **OIDC:** the ID token's signature is checked against the provider's keys (cached one hour, fetched again once for an unknown key id); `iss`, `aud`, `exp`, `nonce` and `azp` are checked. The `state` is kept server-side (hashed) for 10 minutes, used once, and bound to the browser that started the sign-in by a cookie.
- **SAML:** the request ID is kept server-side and the response must answer it (`InResponseTo`, used once), since the provider's cross-site POST carries no SameSite=Lax cookie. Audience, Destination, Recipient, the issuer (when entered) and validity are checked; a replayed assertion is refused. The ACS path is the only one exempt from the cross-site POST check. XML signatures are checked by `@node-saml/node-saml` (pinned), with tests against signature-wrapping shapes.
- Where to go after signing in is a path of this app only.
- Sign-ins and failures (with the reason) are audited (`auth.signIn`, `auth.signInFailed` with method `sso`), as are account creation and access changes from groups (`sso.accountCreated`, `sso.accessSynced`) and every change in Settings.

## Troubleshooting

| The sign-in page says | Look at |
| --- | --- |
| "can't be reached" | The provider's discovery or keys endpoint from the server (firewall, DNS, https) |
| "isn't set up completely" | `PUBLIC_URL`, the issuer, the SAML certificate and sign-in URL |
| "took too long or was already used" | The sign-in took over 10 minutes, the back button, or a second tab |
| "couldn't be verified" | Clock skew, the client ID (audience), the SP entity ID at the provider, the certificate after a rollover |
| "isn't set up on this server yet" | JIT is off and the person has no provisioned or linked account |

The server log has the detail of each failure (`[sso] <provider>: …`).
