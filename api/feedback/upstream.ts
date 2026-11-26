// Feedback shared with inkledger's developers (studio design, second version: opt-in, per
// feedback, under the free plan's quotas). Off unless an admin turns it on, and even then
// only the feedback whose author ticked the consent leaves, anonymised: no name, username or
// email; a pseudonym per person (an HMAC with a secret that never leaves this server) and
// only the shape of the page's path. It goes to the feedback inbox (FEEDBACK_URL, protocol
// v2 in docs/self-hosting.md), signed with this server's instance key under a context of
// its own: queued items in one batch per maintenance cycle (no send at creation), and the
// developers' states read back at most once a day, only while something shared is still open,
// with a cursor and an ETag (304 when nothing changed). No timer of its own.
import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { feedback, feedbackComments, type Feedback } from "@db/schema";
import { isFeedbackStatus, routePattern, type FeedbackStatus } from "@contracts/feedback";
import { getDb } from "../queries/connection";
import { env } from "../lib/env";
import { sha256Hex } from "../lib/hash";
import { hmacHex } from "../lib/secrets";
import { getServerSetting, setServerSetting, updateServerSetting } from "../lib/serverSettings";
import { openBytesFor } from "../lib/crypto";
import { instance } from "../modules/instance";
import { recordSystem } from "../lib/audit";
import { InboxError, callInbox } from "./client";
import { notifyAuthor, setFeedbackStatus } from "./store";

const SHARING_KEY = "feedback.sharing";
const SALT_KEY = "feedback.salt";
/** Until when the inbox asked not to be sent to (a 429's Retry-After), ms. */
const PAUSE_KEY = "feedback.pausedUntil";
/** The status read-back's cursor, ETag and last time. */
const SYNC_KEY = "feedback.statusSync";
export const FEEDBACK_CONTEXT = "inkledger-feedback-v1\n";
/** Per cycle at most (the inbox takes 20 a day per server anyway). */
const SEND_PER_CYCLE = 20;
/** A batch's body stays under the inbox's 1 MB. */
const BATCH_MAX_BYTES = 900 * 1024;
/** A screenshot leaves only this small (the sheet recompresses it in the browser). */
export const SHARED_SCREENSHOT_MAX_BYTES = 300 * 1024;
/** States are read back at most this often. */
export const STATUS_EVERY_MS = 24 * 3_600_000;
/** The developers' states after which nothing more is expected. */
const CLOSED: FeedbackStatus[] = ["implemented", "rejected"];

/** The inbox is configured at all (FEEDBACK_URL empty or "off" hides sharing). */
export const sharingAvailable = () => Boolean(env.feedbackUrl);

/** Whether this server shares feedback with inkledger's developers (off by default). */
export async function sharingEnabled(): Promise<boolean> {
  return sharingAvailable() && (await getServerSetting<boolean>(SHARING_KEY, false)) === true;
}

export async function setSharing(enabled: boolean): Promise<void> {
  await setServerSetting(SHARING_KEY, enabled);
}

/** A person as the developers see them: the same pseudonym every time, never their id. */
export async function userPseudonym(userId: number): Promise<string> {
  const salt = await updateServerSetting<string>(SALT_KEY, "", (cur) => (cur.length >= 32 ? cur : randomBytes(32).toString("base64url")));
  return hmacHex(salt, `feedback-user\n${userId}`).slice(0, 32);
}

/** What a call's signature covers (protocol v2; vectors in __fixtures__/signature-vectors.json). */
export const signedMessage = (method: string, pathAndQuery: string, time: string, instanceId: string, body: string) =>
  `${FEEDBACK_CONTEXT}${method}\n${pathAndQuery}\n${time}\n${instanceId}\n${sha256Hex(body)}`;

/** The headers that sign a call to the inbox (it checks them with the public key they carry). */
export function signedHeaders(method: "GET" | "POST", pathAndQuery: string, body: string, now = Date.now()): Record<string, string> {
  const me = instance();
  const time = String(now);
  const message = signedMessage(method, pathAndQuery, time, me.id, body);
  return { "x-ikl-instance": me.id, "x-ikl-pubkey": me.pubkey, "x-ikl-time": time, "x-ikl-sig": me.sign(message) };
}

export type UpstreamItem = {
  id: string;
  user: string;
  type: string;
  title: string;
  body: string;
  route: string;
  appVersion: string;
  look: string;
  density: "compact" | "comfortable";
  locale: "it" | "en";
  createdAt: number;
  screenshot?: { type: string; data: string };
};

/** Sealed for its row: bytes moved to another feedback don't open. */
export const screenshotScope = (uid: string) => `feedback-shot:${uid}`;

/** What leaves this server for one feedback: nothing that names its author or what they looked at. */
export async function payloadOf(row: Feedback, locale: "it" | "en"): Promise<UpstreamItem> {
  const bytes = row.shareScreenshot === 1 && row.screenshot && row.screenshotType ? openBytesFor(row.screenshot, screenshotScope(row.uid)) : null;
  // Only a picture small enough leaves (the sheet makes it so); a larger one stays here.
  const shot = bytes && row.screenshotType && bytes.length <= SHARED_SCREENSHOT_MAX_BYTES ? { type: row.screenshotType, data: bytes.toString("base64") } : null;
  return {
    id: row.uid,
    user: await userPseudonym(row.userId),
    type: row.type,
    title: row.title,
    body: row.body,
    route: routePattern(row.page),
    appVersion: row.appVersion.slice(0, 64) || "unknown",
    look: row.look.slice(0, 40) || "unknown",
    density: row.density === "comfortable" ? "comfortable" : "compact",
    locale,
    createdAt: row.createdAt.getTime(),
    ...(shot ? { screenshot: shot } : {}),
  };
}

/** Items in batches whose body stays under the inbox's limit, in order. */
export function batches<T>(items: T[], size: (t: T) => number, max = BATCH_MAX_BYTES): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const it of items) {
    const n = size(it);
    if (cur.length && (bytes + n > max || cur.length >= 20)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

type Result = { id: string; ok?: true; error?: string };
const resultsOf = (raw: unknown): Result[] => {
  const r = raw && typeof raw === "object" ? (raw as { results?: unknown }).results : undefined;
  return Array.isArray(r) ? r.filter((x): x is Result => !!x && typeof x === "object" && typeof (x as Result).id === "string") : [];
};

/** Until when the inbox asked us to wait (0: not paused). */
export const pausedUntil = () => getServerSetting<number>(PAUSE_KEY, 0);

/**
 * Sends what is queued (when sharing is on, and the inbox didn't ask to wait): the cycle's
 * items in as few signed batches as fit. Each item's outcome kept; a 429 keeps the queue
 * and the pause it asked for; anything else unanswered is tried on the next cycle.
 */
export async function forwardQueued(o: { now?: number; locale?: "it" | "en" } = {}): Promise<{ sent: number; refused: number; failed: number }> {
  const out = { sent: 0, refused: 0, failed: 0 };
  if (!(await sharingEnabled())) return out;
  const now = o.now ?? Date.now();
  if ((await pausedUntil()) > now) return out;
  const rows = await getDb().select().from(feedback).where(eq(feedback.shareState, "queued")).orderBy(feedback.id).limit(SEND_PER_CYCLE);
  const ready: { row: Feedback; item: UpstreamItem; json: string }[] = [];
  for (const row of rows) {
    // Consent is the row's own: never sent without it, whatever queued it.
    if (row.shareConsent !== 1) {
      await getDb().update(feedback).set({ shareState: null }).where(eq(feedback.id, row.id));
      continue;
    }
    const item = await payloadOf(row, o.locale ?? "it");
    ready.push({ row, item, json: JSON.stringify(item) });
  }
  for (const batch of batches(ready, (r) => r.json.length + 1)) {
    const body = JSON.stringify({ v: 2, items: batch.map((b) => b.item) });
    let results: Result[];
    try {
      const answer = await callInbox("/feedback", { method: "POST", headers: { "content-type": "application/json", ...signedHeaders("POST", "/feedback", body, now) }, body });
      results = resultsOf(answer.json);
    } catch (e) {
      out.failed += batch.length;
      if (e instanceof InboxError && e.code === "rate") {
        // The inbox's word: nothing more before then; the queue stays.
        await setServerSetting(PAUSE_KEY, now + e.retryAfter * 1000);
        console.warn(`[feedback] the inbox asked to wait ${e.retryAfter} s; ${batch.length} kept queued`);
        break;
      }
      // Said in the server's log: an inbox that keeps refusing (a signature, a clock) must not hide behind "queued".
      console.warn(`[feedback] not sent, tried again later: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const byId = new Map(results.map((r) => [r.id, r]));
    for (const { row } of batch) {
      const r = byId.get(row.uid);
      if (!r) {
        out.failed++;
        continue;
      }
      const ok = r.ok === true;
      out[ok ? "sent" : "refused"]++;
      await getDb()
        .update(feedback)
        .set(ok ? { shareState: "sent", sharedAt: new Date(now), upstreamStatus: "new" } : { shareState: "refused" })
        .where(and(eq(feedback.id, row.id), eq(feedback.shareState, "queued")));
    }
  }
  return out;
}

export type StatusItem = { id: string; status: FeedbackStatus; replies: { id: string; body: string; at: number }[] };

/** The inbox's answer, kept to what it may say. */
export function readStatusAnswer(raw: unknown): { cursor: number | null; items: StatusItem[] } {
  const o = raw && typeof raw === "object" ? (raw as { items?: unknown; cursor?: unknown }) : {};
  const items = Array.isArray(o.items) ? o.items : [];
  return {
    cursor: typeof o.cursor === "number" && Number.isFinite(o.cursor) ? o.cursor : null,
    items: items.flatMap((i: unknown) => {
      if (!i || typeof i !== "object") return [];
      const { id, status, replies } = i as { id?: unknown; status?: unknown; replies?: unknown };
      if (typeof id !== "string" || typeof status !== "string" || !isFeedbackStatus(status)) return [];
      const list = Array.isArray(replies)
        ? replies.flatMap((r: unknown) => {
            const { id: rid, body, at } = (r ?? {}) as { id?: unknown; body?: unknown; at?: unknown };
            return typeof rid === "string" && rid.length <= 64 && typeof body === "string" && body.trim() && typeof at === "number" ? [{ id: rid, body: body.slice(0, 5000), at }] : [];
          })
        : [];
      return [{ id, status, replies: list }];
    }),
  };
}

/**
 * The developers' answer applied to one feedback. Their state is applied only when it
 * changed since it was last read (kept apart, upstream_status): an admin here may move it
 * meanwhile and the next read doesn't move it back. Each public reply lands once.
 */
export async function applyUpstream(row: Feedback, item: StatusItem, now = new Date()): Promise<boolean> {
  let changed = false;
  for (const r of item.replies) {
    const [made] = await getDb()
      .insert(feedbackComments)
      .values({ feedbackId: row.id, authorId: null, origin: "upstream", body: r.body, upstreamId: r.id, createdAt: new Date(Math.min(r.at, now.getTime())) })
      .onConflictDoNothing({ target: [feedbackComments.feedbackId, feedbackComments.upstreamId] })
      .returning({ id: feedbackComments.id });
    if (made) {
      changed = true;
      await notifyAuthor(row, "comment", now.getTime());
    }
  }
  if (item.status !== row.upstreamStatus) {
    const reason = item.status === "rejected" ? (item.replies.at(-1)?.body ?? null) : null;
    await setFeedbackStatus(row, item.status, { by: null, reason, origin: "upstream", upstream: item.status, now });
    changed = true;
  }
  return changed;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SyncState = { cursor: number; etag: string | null; at: number };

/** Shared feedback the developers haven't closed: what a read-back is for. */
const openShared = () =>
  getDb()
    .select()
    .from(feedback)
    .where(and(eq(feedback.shareState, "sent"), or(isNull(feedback.upstreamStatus), notInArray(feedback.upstreamStatus, CLOSED))));

/**
 * Reads back the developers' states and replies: at most once a day, only while something
 * shared is still open, one signed request from the last cursor (304: nothing new).
 */
export async function syncStatuses(now = Date.now()): Promise<number> {
  if (!(await sharingEnabled())) return 0;
  const state = (await getServerSetting<SyncState | null>(SYNC_KEY, null)) ?? { cursor: 0, etag: null, at: 0 };
  if (now - state.at < STATUS_EVERY_MS) return 0;
  const open = await openShared();
  if (open.length === 0) return 0;
  const path = `/feedback/status?since=${state.cursor}`;
  let answer;
  try {
    answer = await callInbox(path, { method: "GET", headers: { ...signedHeaders("GET", path, "", now), ...(state.etag ? { "if-none-match": state.etag } : {}) } });
  } catch (e) {
    console.warn(`[feedback] states not read back: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
  if (answer.status === 304) {
    await setServerSetting(SYNC_KEY, { ...state, at: now });
    return 0;
  }
  const { cursor, items } = readStatusAnswer(answer.json);
  const byUid = new Map(open.map((r) => [r.uid, r]));
  // Closed here already, never asked again: still read when the developers answer later.
  const others = items.filter((i) => !byUid.has(i.id) && UUID.test(i.id)).map((i) => i.id);
  if (others.length) for (const r of await getDb().select().from(feedback).where(and(eq(feedback.shareState, "sent"), inArray(feedback.uid, others)))) byUid.set(r.uid, r);
  let updated = 0;
  for (const item of items) {
    const row = byUid.get(item.id);
    if (row && (await applyUpstream(row, item, new Date(now)))) updated++;
  }
  await setServerSetting(SYNC_KEY, { cursor: cursor ?? state.cursor, etag: answer.etag, at: now } satisfies SyncState);
  return updated;
}

/** The maintenance cycle's step (api/boot.ts): send what is queued, read back the rest. Never throws. */
export async function runFeedbackSync(now = Date.now()): Promise<void> {
  try {
    const sent = await forwardQueued({ now });
    const updated = await syncStatuses(now);
    if (sent.sent + sent.refused + updated > 0) await recordSystem({ kind: "system", label: "feedback" }, "feedback.forward", { after: { ...sent, updated } });
  } catch (e) {
    console.warn(`[feedback] sync: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** For tests: the read-back as if never done. */
export const forgetStatusSync = () => setServerSetting(SYNC_KEY, null);
