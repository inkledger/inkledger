// The shapes of a provider's maps (zod), apart from contracts/sso.ts so the sign-in page
// doesn't load zod for a few constants.
import { z } from "zod";
import { PERMISSIONS } from "./accounts";

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
