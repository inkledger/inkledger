// Single sign-on (identity providers) and SCIM provisioning: the shapes the server and the
// Settings page share. A provider is OpenID Connect (Entra ID, Google, Okta, Keycloak…) or
// SAML 2.0; accounts it brings are made at their first sign-in (JIT) with the access its
// groups map to, never an owner unless a group explicitly maps to the owner role.

export const SSO_KINDS = ["oidc", "saml"] as const;
export type SsoKind = (typeof SSO_KINDS)[number];

/** Where an account came from: its own password, its first single sign-on, or SCIM. */
export const AUTH_SOURCES = ["local", "sso", "scim"] as const;
export type AuthSource = (typeof AUTH_SOURCES)[number];

export type { ClaimMap, SsoAccess, GroupMapEntry } from "./ssoSchemas";

/** Why a single sign-on didn't sign anyone in (the login page says it). */
export const SSO_FAILURES = ["unavailable", "notConfigured", "expired", "refused", "invalid", "notProvisioned", "disabled", "throttled"] as const;
export type SsoFailure = (typeof SSO_FAILURES)[number];

/** The query parameter the login page reads a failure from. */
export const SSO_FAILURE_PARAM = "sso";

/** How long a sign-in at the provider may take before its state is gone. */
export const SSO_STATE_MINUTES = 10;

/** SCIM bearer tokens start with this (a secret scanner can tell them). */
export const SCIM_TOKEN_PREFIX = "ikl_scim_";

/** The base path of SCIM 2.0 on this server. */
export const SCIM_BASE = "/scim/v2";
