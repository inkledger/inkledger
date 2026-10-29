// Shortcut as a tracker, through the provider contract. Stories owned by the
// user, keyed sc-123 (the story's public id, the same in every URL); their
// status is the workflow state, categorized by the state's `type` (never its
// name). Shortcut keeps no time inkledger can use (estimates are points): the
// time stays in inkledger's own register.
// Built on a simulator, not verified on a real account: SPIKES.md.
import { z } from "zod";
import type { StatusCategory, TrackerCapabilities, TrackerTraits } from "@contracts/providers";
import { instant, instantFrom, localDate, type JsonValue } from "@contracts/values";
import { secretOf } from "../core/context";
import { decodeCheckpoint, decodePageToken, encodeCheckpoint, encodePageToken } from "../core/checkpoint";
import { ProviderError } from "../core/errors";
import { hmacHex, sameSecret } from "../core/webhooks";
import type { ActiveWorkflowSource, CallContext, ChangeValue, IssueHandle, IssueRef, RemoteChange, RemoteComment, RemoteIssue, RemotePerson, RemoteStatus, TrackerProvider, Transition } from "../types";
import {
  SEARCH_PAGE_MAX,
  sc,
  scOk,
  scSearch,
  type ShortcutComment,
  type ShortcutCreds,
  type ShortcutHistory,
  type ShortcutMe,
  type ShortcutMember,
  type ShortcutStory,
  type ShortcutWorkflow,
  type ShortcutState,
} from "./client";
import { statusSteps } from "../core/statusSteps";

const MD = ["paragraph", "emphasis", "strong", "code", "codeBlock", "link", "list", "heading", "quote", "table", "image"] as const;

export const shortcutCapabilities: TrackerCapabilities = {
  // The workflow's states; any state of the story's own workflow can be moved to from any other.
  workflow: { sources: [{ kind: "itemState", transitions: "direct" }] },
  transitions: { read: true, write: true },
  statuses: true,
  searchText: true,
  query: null,
  comments: { mode: "readWrite", formats: ["commonmark"], writePreserves: [...MD], idempotency: "local" },
  description: true,
  containers: false,
  manage: { assign: false, labels: false, create: false, edit: false, types: false },
  watch: true,
  inbox: false,
  otherFields: false,
  history: true,
  statusHistory: true,
  time: { mode: "local", remoteTotals: false },
  sync: {
    issueCheckpoints: true,
    // Archived stories are reported as deleted; a hard delete shows only on the webhook or a reconciliation (SPIKES.md).
    gone: { deleted: true, lostAccess: false, movedOut: false, transfer: "none" },
    webhooks: [
      { event: "issueChanged", payload: "signal" },
      { event: "issueRemoved", payload: "signal" },
      { event: "commentAdded", payload: "signal" },
    ],
  },
};

export const shortcutTraits: TrackerTraits = {
  create: true,
  inbox: false,
  relations: true,
  devLinks: true,
  attachments: { read: true, upload: true },
  timeboxes: ["iteration"],
  fields: ["due", "points", "labels", "multiAssignee", "custom"],
};

const optionsSchema = z.strictObject({});
export type ShortcutOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"shortcut", ShortcutOptions>;

/** Format of this adapter's checkpoints (core/checkpoint.ts). */
const V = 1;
type Since = { at: number };
/** Where a pass is: the user's stories ("feed"), then, on an incremental pass, the archived ones that changed. */
type PageAt = { phase: "feed" | "archived"; next: string | null; mention: string; at: number };

/** Overlap read again at each pass: the search index lags the story, and `updated:` counts whole days. */
const OVERLAP_MS = 5 * 60_000;
/** A story open to the world has no more than 200 requests a minute behind it. */
const PER_HOUR = 200 * 60;

async function credsOf(x: X): Promise<ShortcutCreds> {
  const cred = await x.conn.credential();
  return { apiBase: x.conn.baseUrl, token: secretOf(cred) };
}

/** sc-123: the prefix and the story's public id. */
export const STORY_KEY = /^sc-(\d{1,12})$/i;
const normalizeKey = (raw: string) => {
  const m = STORY_KEY.exec(raw.trim());
  return m ? `sc-${Number(m[1])}` : null;
};
const idOfKey = (key: string) => STORY_KEY.exec(key.trim())?.[1] ?? null;
/** The story id an issue reference points to, when it points to one. */
const storyId = (ref: { remoteId?: string; key?: string }) => (ref.remoteId && /^\d+$/.test(ref.remoteId) ? ref.remoteId : ref.key ? idOfKey(ref.key) : null);

// ---------- Workflows, members ----------

export type Lookups = { workflows: ShortcutWorkflow[]; members: Map<string, ShortcutMember> };
/** Workflows and members, read once per call (a story names its state and people by id only). */
const looked = new WeakMap<ShortcutCreds, Promise<Lookups>>();
function lookups(c: ShortcutCreds): Promise<Lookups> {
  let p = looked.get(c);
  if (!p) {
    p = (async () => {
      const [workflows, members] = await Promise.all([
        scOk<ShortcutWorkflow[]>(c, "/workflows"),
        // Names are a nicety: a token that can't list members still syncs.
        scOk<ShortcutMember[]>(c, "/members").catch((e: unknown) => {
          if (e instanceof ProviderError && ["forbidden", "notFound", "invalid"].includes(e.kind)) return [];
          throw e;
        }),
      ]);
      return { workflows, members: new Map(members.map((m) => [m.id, m])) };
    })();
    looked.set(c, p);
  }
  return p;
}

const CATEGORY: Record<string, StatusCategory> = { backlog: "backlog", unstarted: "todo", started: "doing", done: "done" };

/** A workflow state as a status; the workflow is its source (states belong to one workflow). */
export const statusOf = (s: ShortcutState, workflowId: number): RemoteStatus => ({
  id: String(s.id),
  name: s.name,
  category: CATEGORY[s.type] ?? "todo",
  categoryOrigin: { by: "native" },
  source: { kind: "itemState", containerRemoteId: String(workflowId) },
  nativeReason: s.type,
  ...(s.color ? { color: s.color } : {}),
  ...(s.position != null ? { order: s.position } : {}),
});

const slug = (name: string, id: number) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `workflow-${id}`;

const personOf = (id: string, l: Lookups): RemotePerson => {
  const m = l.members.get(id);
  if (!m) return { remoteId: id, name: id };
  return { remoteId: id, name: m.profile.name || m.profile.mention_name, avatarUrl: m.profile.display_icon?.url ?? null, handle: m.profile.mention_name };
};

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const updatedOf = (s: ShortcutStory) => instantFrom(s.updated_at ?? s.created_at);

export function toRemoteIssue(s: ShortcutStory, l: Lookups): RemoteIssue {
  const w = l.workflows.find((x) => x.id === s.workflow_id) ?? l.workflows.find((x) => x.states.some((st) => st.id === s.workflow_state_id));
  const state = w?.states.find((st) => st.id === s.workflow_state_id);
  // A state that is gone (its workflow archived): the story's own flags still say where it stands.
  const status: RemoteStatus = state && w
    ? statusOf(state, w.id)
    : {
        id: String(s.workflow_state_id),
        name: `State ${s.workflow_state_id}`,
        category: s.completed ? "done" : s.started ? "doing" : "todo",
        categoryOrigin: { by: "native" },
        source: { kind: "itemState", containerRemoteId: String(s.workflow_id) },
      };
  const changed = s.moved_at ?? (status.category === "done" ? s.completed_at : status.category === "doing" ? s.started_at : null);
  return {
    remoteId: String(s.id),
    key: `sc-${s.id}`,
    url: s.app_url,
    title: s.name,
    type: { id: s.story_type, name: titleCase(s.story_type), level: s.parent_story_id ? "sub" : "standard" },
    status,
    container: { remoteId: String(w?.id ?? s.workflow_id), key: slug(w?.name ?? "", w?.id ?? s.workflow_id), name: w?.name ?? `Workflow ${s.workflow_id}`, kind: "x-workflow" },
    labels: (s.labels ?? []).map((x) => x.name),
    assignees: s.owner_ids.map((id) => personOf(id, l)),
    reporter: s.requested_by_id ? personOf(s.requested_by_id, l) : null,
    // A date-time at midnight UTC: the day it says, never shifted into the user's zone.
    due: s.deadline ? localDate(s.deadline.slice(0, 10)) : null,
    estimateSeconds: null,
    createdAt: instantFrom(s.created_at),
    updatedAt: updatedOf(s),
    statusChangedAt: instantFrom(changed ?? null),
    parent: s.parent_story_id ? { remoteId: String(s.parent_story_id), key: `sc-${s.parent_story_id}` } : null,
    ...(s.estimate != null ? { fields: { estimate: s.estimate } satisfies Record<string, JsonValue> } : {}),
  };
}

const toRemoteComment = (c: ShortcutComment, l: Lookups): RemoteComment => ({
  id: String(c.id),
  // An integration's comment has no author id, only the id it gave.
  author: c.author_id ? personOf(c.author_id, l) : { remoteId: `external:${c.external_id ?? "shortcut"}`, name: "Shortcut", avatarUrl: null },
  body: { kind: "text", format: "commonmark", text: c.text ?? "" },
  createdAt: instantFrom(c.created_at),
  updatedAt: instantFrom(c.updated_at ?? c.created_at),
});

/** A story by id; null when it is gone or not visible (Shortcut answers 404 to both). */
async function storyBy(c: ShortcutCreds, id: string): Promise<ShortcutStory | null> {
  const r = await sc<ShortcutStory>(c, `/stories/${id}`, { missingIsNull: true });
  return r?.data ?? null;
}

const must = (ref: IssueRef): string => {
  const id = storyId(ref);
  if (!id) throw new ProviderError("notFound", `Shortcut: ${ref.key} is not a story`);
  return id;
};

// ---------- Search ----------

const quote = (s: string) => `"${s.replace(/["\\]/g, "")}"`;
/** A word of the user's text for the search: an operator-looking word (owner:x, -x) is quoted, so it is only text. */
const word = (t: string) => {
  const w = t.replace(/"/g, "");
  return !w ? null : /[:!()]/.test(w) || /^[-+]/.test(w) ? quote(w) : w;
};
const textQuery = (text: string) => text.split(/\s+/).map(word).filter((w): w is string => w !== null).join(" ");

/** `updated:` takes days, counted in UTC. */
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function feedQuery(phase: PageAt["phase"], mention: string, since: number | null): string {
  const who = /^[\w.-]+$/.test(mention) ? mention : quote(mention);
  return `owner:${who}${phase === "archived" ? " is:archived" : ""}${since === null ? "" : ` updated:${utcDay(since)}..*`}`;
}


/** A value as words: scalars as they are, anything else as JSON (never "[object Object]"). */
const asText = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : v === null || v === undefined ? "" : JSON.stringify(v));

export const shortcutProvider: TrackerProvider<"shortcut", ShortcutOptions> = {
  // Deliveries signed with the webhook's secret (Payload-Signature, hex HMAC-SHA256 of the raw body); the body's id is the delivery id.
  webhook: {
    verify(req, secret) {
      const given = headerOf(req.headers, "payload-signature");
      return !!given && /^[0-9a-f]{64}$/i.test(given) && sameSecret(given.toLowerCase(), hmacHex(secret, req.body));
    },
    deliveryId: (req) => bodyField(req.body, "id"),
    sentAt: (req) => {
      const at = bodyField(req.body, "changed_at");
      const ms = at ? Date.parse(at) : NaN;
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    },
  },
  role: "tracker",
  type: "shortcut",
  capabilities: shortcutCapabilities,
  traits: shortcutTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Shortcut options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  normalizeKey,

  parseRef(_r, text): IssueHandle | null {
    const key = normalizeKey(text);
    if (key) return { key };
    try {
      // https://app.shortcut.com/<workspace>/story/123/<slug>: the slug follows the name, only the id counts. Epics have their own ids and pages.
      const url = new URL(text.trim());
      if (url.origin !== "https://app.shortcut.com") return null;
      const m = /^\/[^/]+\/story\/(\d{1,12})(?:\/[^/]*)?\/?$/.exec(url.pathname);
      const k = m ? normalizeKey(`sc-${m[1]}`) : null;
      return k ? { key: k } : null;
    } catch {
      return null;
    }
  },

  async verify(x) {
    const c = await credsOf(x);
    const me = await scOk<ShortcutMe>(c, "/member");
    // /member has no email or picture: the member list does, when this token may read it.
    const listed = await scOk<ShortcutMember[]>(c, "/members").catch((e: unknown) => {
      if (e instanceof ProviderError && ["forbidden", "notFound", "invalid"].includes(e.kind)) return [];
      throw e;
    });
    const m = listed.find((u) => u.id === me.id);
    return {
      remoteId: me.id,
      name: me.name || me.mention_name,
      avatarUrl: m?.profile.display_icon?.url ?? null,
      handle: me.mention_name,
      login: me.mention_name,
      ...(m?.profile.email_address ? { email: m.profile.email_address } : {}),
    };
  },

  async probe(x) {
    const c = await credsOf(x);
    const { workflows } = await lookups(c);
    // One source per workflow (states are the workflow's).
    const activeSources: ActiveWorkflowSource[] = workflows.length
      ? workflows.map((w) => ({ kind: "itemState", transitions: "direct", ref: { kind: "itemState", containerRemoteId: String(w.id) }, name: w.name }))
      : [{ kind: "itemState", transitions: "direct", ref: { kind: "itemState" }, name: "Shortcut workflow" }];
    return { capabilities: shortcutCapabilities, activeSources, rateLimit: { perHour: PER_HOUR, origin: "typical" }, verifiedAt: instant(Date.now()) };
  },

  async listChanged(x, q) {
    const c = await credsOf(x);
    const since = decodeCheckpoint<Since>(x.conn, "issues", V, q.since)?.at ?? null;
    const at =
      decodePageToken<PageAt>(x.conn, "issues", V, q.since, q.page) ??
      // The pass starts now: its checkpoint (on the last page) is this moment, less the overlap. `owner:` takes the mention name, not the id.
      ({ phase: "feed", next: null, mention: (await scOk<ShortcutMe>(c, "/member")).mention_name, at: Date.now() } satisfies PageAt);
    const page = await scSearch(c, at.next ? { next: at.next } : { query: feedQuery(at.phase, at.mention, since), pageSize: SEARCH_PAGE_MAX });
    // `updated:` is a day; the exact cut is the story's own time.
    const fresh = page.data.filter((s) => since === null || (updatedOf(s) ?? 0) >= since);

    const items: RemoteIssue[] = [];
    const gone: { remoteId: string; reason: "deleted" }[] = [];
    if (at.phase === "feed") {
      const l = fresh.some((s) => !s.archived) ? await lookups(c) : null;
      for (const s of fresh) {
        if (s.archived) gone.push({ remoteId: String(s.id), reason: "deleted" });
        else if (l) items.push(toRemoteIssue(s, l));
      }
    } else for (const s of fresh) gone.push({ remoteId: String(s.id), reason: "deleted" });

    const next = (p: PageAt) => ({ last: false as const, items, gone, next: encodePageToken(x.conn, "issues", V, q.since, p) });
    if (page.next) return next({ ...at, next: page.next });
    // Archived stories are not in the search unless asked for: a first read has none to take away.
    if (at.phase === "feed" && since !== null) return next({ ...at, phase: "archived", next: null });
    return { last: true as const, items, gone, checkpoint: encodeCheckpoint(x.conn, "issues", V, { at: at.at - OVERLAP_MS } satisfies Since) };
  },

  async getIssue(x, ref) {
    const c = await credsOf(x);
    const id = storyId(ref);
    const s = id ? await storyBy(c, id) : null;
    return s ? toRemoteIssue(s, await lookups(c)) : null;
  },

  async findIssue(x, handle) {
    const c = await credsOf(x);
    const id = storyId(handle);
    const s = id ? await storyBy(c, id) : null;
    return s ? { kind: "found", issue: toRemoteIssue(s, await lookups(c)) } : { kind: "none" };
  },

  async searchText(x, text, limit) {
    const query = textQuery(text);
    if (!query) return { items: [], complete: true };
    const c = await credsOf(x);
    const found: ShortcutStory[] = [];
    let next: string | null = null;
    let first = true;
    // Pages of at most 25; archived stories are not in a search unless asked for.
    while (first || (next && found.length < limit)) {
      const page: Awaited<ReturnType<typeof scSearch>> = await scSearch(c, next ? { next } : { query, pageSize: Math.min(SEARCH_PAGE_MAX, limit) });
      found.push(...page.data);
      next = page.next;
      first = false;
    }
    const l = found.length ? await lookups(c) : null;
    return { items: l ? found.slice(0, limit).map((s) => toRemoteIssue(s, l)) : [], complete: next === null && found.length <= limit };
  },

  async statuses(x, source) {
    const { workflows } = await lookups(await credsOf(x));
    const only = source.ref.kind === "itemState" ? source.ref.containerRemoteId : undefined;
    return workflows.filter((w) => !only || String(w.id) === only).flatMap((w) => w.states.map((s) => statusOf(s, w.id)));
  },

  async description(x, ref) {
    const s = await storyBy(await credsOf(x), must(ref));
    const text = s?.description;
    return text?.trim() ? { kind: "text", format: "commonmark", text } : null;
  },

  transitions: {
    async list(x, ref) {
      const c = await credsOf(x);
      const s = await storyBy(c, must(ref));
      if (!s) throw new ProviderError("notFound", `Shortcut: no story ${ref.key}`);
      const w = (await lookups(c)).workflows.find((v) => v.id === s.workflow_id);
      // Any state of the story's own workflow, from any state: a state of another workflow is refused.
      return [...(w?.states ?? [])]
        .filter((st) => st.id !== s.workflow_state_id)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id - b.id)
        .map<Transition>((st) => ({ id: String(st.id), name: st.name, to: statusOf(st, s.workflow_id), requirements: [], remoteUrl: s.app_url }));
    },
    async apply(x, ref, transitionId) {
      const c = await credsOf(x);
      if (!/^\d+$/.test(transitionId)) throw new ProviderError("invalid", `Shortcut: ${transitionId} is not a workflow state`);
      const s = await scOk<ShortcutStory>(c, `/stories/${must(ref)}`, { method: "PUT", body: JSON.stringify({ workflow_state_id: Number(transitionId) }) });
      return toRemoteIssue(s, await lookups(c));
    },
  },

  comments: {
    async list(x, ref) {
      const c = await credsOf(x);
      const [comments, l] = await Promise.all([scOk<ShortcutComment[]>(c, `/stories/${must(ref)}/comments`), lookups(c)]);
      // Deleted comments stay in the list, marked.
      return comments
        .filter((m) => !m.deleted)
        .sort((a, b) => (instantFrom(a.created_at) ?? 0) - (instantFrom(b.created_at) ?? 0) || a.id - b.id)
        .map((m) => toRemoteComment(m, l));
    },
    async add(x, ref, body) {
      // Shortcut's comments are Markdown: CommonMark goes as is.
      const c = await credsOf(x);
      const made = await scOk<ShortcutComment>(c, `/stories/${must(ref)}/comments`, { method: "POST", body: JSON.stringify({ text: body }) });
      return { comment: toRemoteComment(made, await lookups(c)), warnings: [] };
    },
  },

  async watch(x, ref, on) {
    const c = await credsOf(x);
    const id = must(ref);
    const s = await storyBy(c, id);
    if (!s) throw new ProviderError("notFound", `Shortcut: no story ${ref.key}`);
    // follower_ids replaces the whole list: the others stay.
    const followers = s.follower_ids ?? [];
    const me = x.conn.remoteAccountId;
    if (followers.includes(me) === on) return;
    const next = on ? [...followers, me] : followers.filter((f) => f !== me);
    await scOk<ShortcutStory>(c, `/stories/${id}`, { method: "PUT", body: JSON.stringify({ follower_ids: next }) });
  },

  async statusHistory(x, ref) {

    return statusSteps(await shortcutProvider.history!(x, ref), (c) => c.field.id === "workflow_state_id");

  },


  async history(x, ref) {
    const c = await credsOf(x);
    const [entries, l] = await Promise.all([scOk<ShortcutHistory[]>(c, `/stories/${must(ref)}/history`), lookups(c)]);
    return entries.flatMap((h) => toChanges(h, l)).sort((a, b) => a.at - b.at);
  },
};

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
}

function bodyField(body: string, field: string): string | null {
  try {
    const v = (JSON.parse(body) as Record<string, unknown>)[field];
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

// ---------- History ----------

const some = (v: unknown, text?: string): ChangeValue[] => (v === null || v === undefined || v === "" ? [] : [{ text: text ?? asText(v), raw: v as JsonValue }]);

/** One history entry may change several fields at once: one change per field. */
export function toChanges(h: ShortcutHistory, l: Lookups): RemoteChange[] {
  const at = instantFrom(h.changed_at);
  if (at === null) return [];
  const actor = h.member_id ? personOf(h.member_id, l) : null;
  const refName = (type: string, id: unknown) => h.references?.find((r) => r.entity_type === type && String(r.id) === String(id))?.name;
  const stateName = (id: unknown) => refName("workflow-state", id) ?? l.workflows.flatMap((w) => w.states).find((s) => s.id === Number(id))?.name ?? `#${String(id)}`;
  const workflowName = (id: unknown) => l.workflows.find((w) => w.id === Number(id))?.name ?? `#${String(id)}`;
  const labelName = (id: unknown) => refName("label", id) ?? `#${String(id)}`;
  const named = (id: unknown, text: (id: unknown) => string): ChangeValue[] => (id === null || id === undefined ? [] : [{ text: text(id), id: asText(id) }]);
  const out: RemoteChange[] = [];
  for (const a of h.actions) {
    if (a.entity_type !== "story" || a.action !== "update" || !a.changes) continue;
    const ch = a.changes;
    const push = (id: string, name: string, from: ChangeValue[], to: ChangeValue[]) => out.push({ at, actor, field: { id, name }, from, to });
    if (ch.workflow_state_id) push("workflow_state_id", "Status", named(ch.workflow_state_id.old, stateName), named(ch.workflow_state_id.new, stateName));
    if (ch.workflow_id) push("workflow_id", "Workflow", named(ch.workflow_id.old, workflowName), named(ch.workflow_id.new, workflowName));
    if (ch.name) push("name", "Title", some(ch.name.old), some(ch.name.new));
    if (ch.description) push("description", "Description", some(ch.description.old), some(ch.description.new));
    if (ch.story_type) push("story_type", "Type", some(ch.story_type.old, titleCase(asText(ch.story_type.old ?? ""))), some(ch.story_type.new, titleCase(asText(ch.story_type.new ?? ""))));
    if (ch.estimate) push("estimate", "Estimate", some(ch.estimate.old), some(ch.estimate.new));
    if (ch.deadline) push("deadline", "Due date", some(ch.deadline.old, asText(ch.deadline.old ?? "").slice(0, 10)), some(ch.deadline.new, asText(ch.deadline.new ?? "").slice(0, 10)));
    if (ch.archived) push("archived", "Archived", some(ch.archived.old, ch.archived.old ? "yes" : "no"), some(ch.archived.new, ch.archived.new ? "yes" : "no"));
    if (ch.owner_ids) {
      const people = (ids: unknown[] | undefined): ChangeValue[] => (ids ?? []).map((id) => ({ text: personOf(String(id), l).name, id: String(id) }));
      push("owner_ids", "Assignee", people(ch.owner_ids.removes), people(ch.owner_ids.adds));
    }
    if (ch.label_ids) {
      const labels = (ids: unknown[] | undefined): ChangeValue[] => (ids ?? []).map((id) => ({ text: labelName(id), id: String(id) }));
      push("label_ids", "Labels", labels(ch.label_ids.removes), labels(ch.label_ids.adds));
    }
  }
  return out;
}
