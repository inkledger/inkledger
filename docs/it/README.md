# IT documentation

For the people who deploy, review and operate an inkledger server.

| Document | For |
| --- | --- |
| [Security at a glance](security-one-pager.md) | A one-page review: architecture, authentication, encryption, permissions, backups |
| [Data flow](data-flow.md) | Where data lives, what is personal, what is encrypted, how long it is kept |
| [Outbound connections](outbound.md) | Every host the server calls, for firewall rules |
| [Single sign-on and SCIM](sso.md) | OIDC and SAML set-up, accounts at first sign-in, SCIM provisioning, enforcement and break-glass |
| [Audit log](audit.md) | What is recorded, integrity, retention |
| [Data protection notes](gdpr.md) | Controller role, categories, retention, export and erasure |
| [Runbook: upgrade](runbook-upgrade.md) | Updating the Docker stack, rollback |
| [Runbook: restore](runbook-restore.md) | Restoring a backup and checking the result |
| [Runbook: rotate keys](runbook-rotation.md) | Changing `CREDENTIALS_KEY` and `SESSION_SECRET` |
| [Runbook: incident](runbook-incident.md) | Containing an account, signing out, rotating, exporting the audit |

Related: [self-hosting guide](../self-hosting.md), [HTTPS](../https.md), [security policy](../../SECURITY.md).
