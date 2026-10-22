// Azure DevOps' REST API (7.1), as the adapter needs it: every call through
// the shared safe fetch, the personal access token as Basic auth (empty user
// name), errors in the layer's words, rate limits read from the headers.
// Paging has no single rule here: callers use what each endpoint documents
// ($top/$skip, continuation tokens in a header or in the body).
import { ProviderError, kindOfStatus } from "../core/errors";
import { safeFetch, type Intent, discardBody } from "../core/http";

export type AzureCreds = {
  /** The collection's root: https://dev.azure.com/{organization}, or a Server's https://host/tfs/{collection} */
  apiBase: string;
  token: string;
};

/** Version asked for each call (the comments API is still a preview in 7.1). */
export const API_VERSION = "7.1";
export const COMMENTS_API_VERSION = "7.1-preview.4";
export const CONNECTION_API_VERSION = "7.1-preview";

export type AzureIdentity = {
  id?: string;
  displayName?: string;
  uniqueName?: string;
  imageUrl?: string;
  descriptor?: string;
  url?: string;
  _links?: { avatar?: { href?: string } };
};
/** An identity field: an object on current versions, "Name <unique name>" on older servers. */
export type AzureIdentityField = AzureIdentity | string;

export type AzureFields = {
  "System.WorkItemType"?: string;
  "System.State"?: string;
  "System.Reason"?: string;
  "System.TeamProject"?: string;
  "System.Title"?: string;
  "System.Description"?: string;
  "System.Tags"?: string;
  "System.AssignedTo"?: AzureIdentityField;
  "System.CreatedBy"?: AzureIdentityField;
  "System.CreatedDate"?: string;
  "System.ChangedDate"?: string;
  "System.StateChangeDate"?: string;
  "System.Parent"?: number;
  "Microsoft.VSTS.Common.Priority"?: number;
  "Microsoft.VSTS.Scheduling.DueDate"?: string;
  /** Hours, a decimal */
  "Microsoft.VSTS.Scheduling.OriginalEstimate"?: number;
  /** Hours, a decimal: the counter */
  "Microsoft.VSTS.Scheduling.CompletedWork"?: number;
  [field: string]: unknown;
};
export type AzureWorkItem = { id: number; rev: number; fields: AzureFields; url?: string };

export type AzureComment = {
  id: number;
  workItemId?: number;
  text?: string;
  isDeleted?: boolean;
  createdBy?: AzureIdentityField;
  createdDate?: string;
  modifiedDate?: string;
};
export type AzureProject = { id: string; name: string };
export type AzureUpdate = {
  id: number;
  rev: number;
  revisedBy?: AzureIdentityField;
  revisedDate?: string;
  fields?: Record<string, { oldValue?: unknown; newValue?: unknown }>;
};
export type AzureConnectionData = { authenticatedUser: { id: string; providerDisplayName?: string; properties?: { Account?: { $value?: string } } } };

/** The fields read for lists and single items: no description (heavy), no relations. */
export const ITEM_FIELDS = [
  "System.WorkItemType",
  "System.State",
  "System.Reason",
  "System.TeamProject",
  "System.Title",
  "System.AssignedTo",
  "System.CreatedBy",
  "System.CreatedDate",
  "System.ChangedDate",
  "System.StateChangeDate",
  "System.Tags",
  "System.Parent",
  "Microsoft.VSTS.Common.Priority",
  "Microsoft.VSTS.Scheduling.DueDate",
  "Microsoft.VSTS.Scheduling.OriginalEstimate",
  "Microsoft.VSTS.Scheduling.CompletedWork",
];

/** Basic auth as Azure DevOps documents it for a PAT: an empty user name. */
export const basicAuth = (token: string) => `Basic ${Buffer.from(`:${token}`).toString("base64")}`;

/** The page of a work item on the web, in its project. */
export const workItemUrl = (apiBase: string, project: string, id: number | string) => `${apiBase.replace(/\/+$/, "")}/${encodeURIComponent(project)}/_workitems/edit/${id}`;

/** An Azure DevOps answer refused, as a ProviderError (a rate limit with when to retry). */
async function refused(res: Response): Promise<ProviderError> {
  let message = `Azure DevOps answered ${res.status}`;
  let typeKey = "";
  try {
    const body = (await res.json()) as { message?: string; typeKey?: string };
    if (body.message) message = `Azure DevOps: ${body.message}`;
    typeKey = body.typeKey ?? "";
  } catch {
    // no JSON body
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 60_000;
    return new ProviderError("rateLimit", message, {
      status: 429,
      rateLimit: { retryAfterMs: waitMs, ...(Number.isFinite(remaining) ? { remaining } : {}), ...(Number.isFinite(reset) && reset > 0 ? { resetAt: reset * 1000 } : {}) },
    });
  }
  // A change made against an older revision is refused as a plain 400 (TF26071) as well as a 409/412.
  if (res.status === 412 || res.status === 409 || /TF26071|RevisionMismatch/i.test(`${message} ${typeKey}`)) return new ProviderError("conflict", message, { status: res.status });
  return new ProviderError(kindOfStatus(res.status), message, { status: res.status });
}

export type AzCall = RequestInit & {
  /** 404 as null */
  missingIsNull?: boolean;
  /** Query parameters (api-version is added) */
  params?: Record<string, string | number | boolean | undefined>;
  version?: string;
  intent?: Intent;
};

/** Azure DevOps Services (dev.azure.com, *.visualstudio.com) is on the internet and never reaches private addresses; a self-hosted server may be on the user's own network. */
const networkOf = (base: string) => {
  const h = new URL(base).hostname.toLowerCase();
  return h === "dev.azure.com" || h.endsWith(".visualstudio.com") ? ("public" as const) : ("private" as const);
};

/** One call. */
export async function az<T>(c: AzureCreds, path: string, init: AzCall = {}): Promise<{ data: T; headers: Headers } | null> {
  const { missingIsNull, params, version, intent, ...rest } = init;
  const url = new URL(`${c.apiBase.replace(/\/+$/, "")}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  url.searchParams.set("api-version", version ?? API_VERSION);
  const res = await safeFetch({
    site: c.apiBase,
    network: networkOf(c.apiBase),
    url: url.toString(),
    intent,
    init: {
      ...rest,
      headers: {
        Accept: "application/json",
        // Without this a refused token is answered with a redirect to a sign-in page, not a 401.
        "X-TFS-FedAuthRedirect": "Suppress",
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(rest.headers as Record<string, string> | undefined),
        Authorization: basicAuth(c.token),
      },
    },
    fail: (status, message) => new ProviderError(status === 403 ? "readOnly" : "invalid", message),
  });
  // A 203 (or a web page where JSON was asked) is the sign-in page: the token wasn't accepted.
  if (res.status === 203 || /text\/html/i.test(res.headers.get("content-type") ?? "")) {
    await discardBody(res);
    throw new ProviderError("auth", "Azure DevOps did not accept the token (it answered with its sign-in page)", { status: res.status });
  }
  if (res.status === 404 && missingIsNull) {
    await discardBody(res);
    return null;
  }
  if (!res.ok) throw await refused(res);
  const data = (res.status === 204 ? undefined : await res.json()) as T;
  return { data, headers: res.headers };
}

/** A call that always answers. */
export async function azOk<T>(c: AzureCreds, path: string, init: AzCall = {}): Promise<T> {
  const r = await az<T>(c, path, init);
  if (!r) throw new ProviderError("notFound", `Azure DevOps: nothing at ${path}`);
  return r.data;
}

/** A JSON-patch call to a work item (the test op on /rev is how a revision is held). */
export type PatchOp = { op: "add" | "replace" | "test" | "remove"; path: string; value?: unknown };
export const patchItem = (c: AzureCreds, id: number | string, ops: PatchOp[]) =>
  azOk<AzureWorkItem>(c, `/_apis/wit/workitems/${id}`, { method: "PATCH", body: JSON.stringify(ops), headers: { "Content-Type": "application/json-patch+json" } });

/** Up to 200 work items by id in one call; ids that don't exist (deleted, no access) are left out. */
export const BATCH_MAX = 200;
export async function itemsByIds(c: AzureCreds, ids: number[], fields: string[] = ITEM_FIELDS): Promise<AzureWorkItem[]> {
  const out: AzureWorkItem[] = [];
  for (let i = 0; i < ids.length; i += BATCH_MAX) {
    // Without errorPolicy "omit" one missing id fails the whole call. Not a write: a POST carrying a list.
    const r = await azOk<{ value: (AzureWorkItem | null)[] }>(c, "/_apis/wit/workitemsbatch", {
      method: "POST",
      intent: "read",
      body: JSON.stringify({ ids: ids.slice(i, i + BATCH_MAX), fields, errorPolicy: "Omit" }),
    });
    out.push(...r.value.filter((w): w is AzureWorkItem => w !== null));
  }
  // The batch's order is not promised: the caller's order is kept.
  const order = new Map(ids.map((id, n) => [id, n]));
  return out.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** The ids a WIQL query finds, with the server's clock when it answered (asOf). Queries across links answer with relations: their targets count. */
export async function wiql(c: AzureCreds, query: string, top?: number): Promise<{ ids: number[]; asOf: number | null }> {
  const r = await azOk<{ asOf?: string; workItems?: { id: number }[]; workItemRelations?: { target?: { id: number } | null }[] }>(c, "/_apis/wit/wiql", {
    method: "POST",
    intent: "read",
    // Without timePrecision a date is compared as a day, whatever time is written.
    params: { timePrecision: true, ...(top === undefined ? {} : { $top: top }) },
    body: JSON.stringify({ query }),
  });
  const ids = r.workItems ? r.workItems.map((w) => w.id) : [...new Set((r.workItemRelations ?? []).flatMap((x) => (x.target ? [x.target.id] : [])))];
  const asOf = r.asOf ? Date.parse(r.asOf) : NaN;
  return { ids, asOf: Number.isFinite(asOf) ? asOf : null };
}
