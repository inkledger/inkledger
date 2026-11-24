// A SCIM 2.0 client as identity providers drive one, for tests: the requests Entra ID and Okta
// send when they provision, update and turn off people and groups, with their quirks:
// - Entra ID: looks a user up by "userName eq" first; PATCH with "Replace" (capital R), a path,
//   and booleans as strings ("False"); group members added and removed by path filter;
// - Okta: PATCH with no path and a value object ({ active: false }); PUT for a full update.
// `call` is the server under test (a Hono app's request, or fetch against a running one).
export type ScimCall = (path: string, init?: RequestInit) => Promise<Response>;

const SCIM_JSON = "application/scim+json";
const USER = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export type ScimPerson = { userName: string; externalId?: string; displayName?: string; email?: string; active?: boolean };

export function scimSimulator(call: ScimCall, token: string, base = "/scim/v2") {
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await call(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": SCIM_JSON, accept: SCIM_JSON },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> | null };
  };
  const userBody = (p: ScimPerson) => ({
    schemas: [USER],
    userName: p.userName,
    ...(p.externalId ? { externalId: p.externalId } : {}),
    displayName: p.displayName ?? p.userName,
    name: { formatted: p.displayName ?? p.userName },
    emails: p.email ? [{ value: p.email, type: "work", primary: true }] : [],
    active: p.active ?? true,
  });

  return {
    send,
    entra: {
      /** Entra's create: a lookup by userName, then a POST when nobody has it. */
      async provision(p: ScimPerson) {
        const found = await send("GET", `/Users?filter=${encodeURIComponent(`userName eq "${p.userName}"`)}`);
        const existing = (found.body?.Resources as { id: string }[] | undefined)?.[0];
        return existing ? { status: 200, body: existing as Record<string, unknown> } : send("POST", "/Users", userBody(p));
      },
      setActive: (id: string, active: boolean) => send("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "Replace", path: "active", value: active ? "True" : "False" }] }),
      rename: (id: string, displayName: string) => send("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "Replace", path: "displayName", value: displayName }] }),
      createGroup: (displayName: string, externalId: string) => send("POST", "/Groups", { schemas: [GROUP], displayName, externalId, members: [] }),
      addMember: (groupId: string, userId: string) => send("PATCH", `/Groups/${groupId}`, { schemas: [PATCH], Operations: [{ op: "Add", path: "members", value: [{ value: userId }] }] }),
      removeMember: (groupId: string, userId: string) => send("PATCH", `/Groups/${groupId}`, { schemas: [PATCH], Operations: [{ op: "Remove", path: `members[value eq "${userId}"]` }] }),
    },
    okta: {
      create: (p: ScimPerson) => send("POST", "/Users", userBody(p)),
      replace: (id: string, p: ScimPerson) => send("PUT", `/Users/${id}`, userBody(p)),
      deactivate: (id: string) => send("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [{ op: "replace", value: { active: false } }] }),
    },
    remove: (id: string) => send("DELETE", `/Users/${id}`),
  };
}
