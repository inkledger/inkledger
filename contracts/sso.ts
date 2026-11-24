// Single sign-on (identity providers) and SCIM provisioning: the shapes the server and the
// Settings page share. A provider is OpenID Connect (Entra ID, Google, Okta, Keycloak…) or
// SAML 2.0; accounts it brings are made at their first sign-in (JIT) with the access its
// groups map to, never an owner unless a group explicitly maps to the owner role.
import { z } from "zod";
import { PERMISSIONS } from "./accounts";

export const SSO_KINDS = ["oidc", "saml"] as const;
export type SsoKind = (typeof SSO_KINDS)[number];

/** Where an account came from: its own password, its first single sign-on, or SCIM. */
export const AUTH_SOURCES = ["local", "sso", "scim"] as const;
export type AuthSource = (typeof AUTH_SOURCES)[number];

const claimName = z.string().trim().max(256);

/** Which claim (OIDC) or attribute (SAML) holds each value; empty: the usual one. */
export const claimMapSchema = z.object({
  /** The stable id the account is linked by (OIDC "sub"; Entra: "oid", which SCIM sends as externalId) */
  subject: claimName.optional(),
  username: claimName.optional(),
  email: claimName.optional(),
  name: claimName.optional(),
  groups: claimName.optional(),
});
export type ClaimMap = z.infer<typeof claimMapSchema>;

/** Access as a provider hands it out: a server-wide role, grants of its own, teams. */
export const ssoAccessSchema = z.object({
  roleId: z.number().int().positive().nullable().optional(),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).default([]),
  teamIds: z.array(z.number().int().positive()).max(100).default([]),
});
export type SsoAccess = z.infer<typeof ssoAccessSchema>;

/** One group (its id or name as the provider sends it) and the access it brings. */
export const groupMapEntrySchema = ssoAccessSchema.extend({ group: z.string().trim().min(1).max(256) });
export type GroupMapEntry = z.infer<typeof groupMapEntrySchema>;
export const groupMapSchema = z.array(groupMapEntrySchema).max(200);

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
