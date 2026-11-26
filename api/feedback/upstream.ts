// Feedback shared with inkledger's developers (studio design: opt-in, per feedback). Off
// unless an admin turns it on, and even then only the feedback whose author ticked the
// consent leaves, anonymised: no name, username or email; a pseudonym per person (an HMAC
// with a secret that never leaves this server) and only the shape of the page's path. It
// goes to the Store Worker (POST /feedback), signed with this server's instance key under
// a context of its own, and the developers' state and public replies are read back
// (GET /feedback/status) on the server's existing purge cadence: no timer of its own.
import { randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { feedback, feedbackComments, type Feedback } from "@db/schema";
import { isFeedbackStatus, routePattern, type FeedbackStatus } from "@contracts/feedback";
import { getDb } from "../queries/connection";
import { env } from "../lib/env";
import { sha256Hex } from "../lib/hash";
import { hmacHex } from "../lib/secrets";
import { getServerSetting, setServerSetting, updateServerSetting } from "../lib/serverSettings";
import { openBytesFor } from "../lib/crypto";
import { instance } from "../modules/instance";
import { StoreError, callStore } from "../store/client";
import { recordSystem } from "../lib/audit";
import { notifyAuthor, sentFeedback, setFeedbackStatus } from "./store";

const SHARING_KEY = "feedback.sharing";
const SALT_KEY = "feedback.salt";
export const FEEDBACK_CONTEXT = "inkledger-feedback-v1\n";
/** Sent per cycle at most, and states read back per call (the Worker's own cap). */
const SEND_PER_CYCLE = 20;
const STATUS_BATCH = 50;
const STATUS_PER_CYCLE = 200;

/** The Store is reachable at all (STORE_URL=off hides sharing). */
export const sharingAvailable = () => Boolean(env.storeUrl);

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

/** The headers that sign a call to the Store (the Worker checks them: store/src/worker.ts). */
export function signedHeaders(method: "GET" | "POST", pathAndQuery: string, body: string, now = Date.now()): Record<string, string> {
  const me = instance();
  const time = String(now);
  const message = `${FEEDBACK_CONTEXT}${method}\n${pathAndQuery}\n${time}\n${me.id}\n${sha256Hex(body)}`;
  return { "x-ikl-instance": me.id, "x-ikl-pubkey": me.pubkey, "x-ikl-time": time, "x-ikl-sig": me.sign(message) };
}

export type UpstreamPayload = {
  v: 1;
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

/** What leaves this server for one feedback: nothing that names its author or what they looked at. */
export async function payloadOf(row: Feedback, locale: "it" | "en"): Promise<UpstreamPayload> {
  const shot = row.shareScreenshot === 1 && row.screenshot && row.screenshotType ? { type: row.screenshotType, data: openBytesFor(row.screenshot, screenshotScope(row.uid)).toString("base64") } : null;
  return {
    v: 1,
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

/** Sealed for its row: bytes moved to another feedback don't open. */
export const screenshotScope = (uid: string) => `feedback-shot:${uid}`;

type Outcome = "sent" | "refused" | "later";

/** One feedback to the Store: sent, refused for good (its input), or to try again later. */
async function sendOne(row: Feedback, locale: "it" | "en", now: number): Promise<Outcome> {
  const body = JSON.stringify(await payloadOf(row, locale));
  try {
    await callStore("/feedback", { method: "POST", headers: { "content-type": "application/json", ...signedHeaders("POST", "/feedback", body, now) }, body });
  } catch (e) {
    // The Store said no to this one (its input, its size): never again. Anything else (rate,
    // not there yet, unreachable, a signature off by a clock) is tried on the next cycle.
    if (e instanceof StoreError && e.code === "rejected" && (e.status === 400 || e.status === 413)) return "refused";
    // Said in the server's log: a Store that keeps refusing (a signature, a clock) must not hide behind "queued".
    console.warn(`[feedback] not sent, tried again later: ${e instanceof Error ? e.message : String(e)}`);
    return "later";
  }
  return "sent";
}

/** Sends what is queued (when sharing is on); every row's outcome kept. */
export async function forwardQueued(o: { now?: number; locale?: "it" | "en"; ids?: number[] } = {}): Promise<{ sent: number; refused: number; failed: number }> {
  const out = { sent: 0, refused: 0, failed: 0 };
  if (!(await sharingEnabled())) return out;
  const now = o.now ?? Date.now();
  const where = o.ids ? and(eq(feedback.shareState, "queued"), inArray(feedback.id, o.ids)) : eq(feedback.shareState, "queued");
  const rows = await getDb().select().from(feedback).where(where).orderBy(feedback.id).limit(SEND_PER_CYCLE);
  for (const row of rows) {
    // Consent is the row's own: never sent without it, whatever queued it.
    if (row.shareConsent !== 1) {
      await getDb().update(feedback).set({ shareState: null }).where(eq(feedback.id, row.id));
      continue;
    }
    const r = await sendOne(row, o.locale ?? "it", now);
    if (r === "later") {
      out.failed++;
      continue;
    }
    out[r]++;
    await getDb()
      .update(feedback)
      .set(r === "sent" ? { shareState: "sent", sharedAt: new Date(now), upstreamStatus: "new" } : { shareState: "refused" })
      .where(and(eq(feedback.id, row.id), eq(feedback.shareState, "queued")));
  }
  return out;
}

export type UpstreamItem = { id: string; status: FeedbackStatus; replies: { id: string; body: string; at: number }[] };

/** The Worker's answer, kept to what it may say. */
export function readStatusAnswer(raw: unknown): UpstreamItem[] {
  const items = raw && typeof raw === "object" ? (raw as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) return [];
  return items.flatMap((i: unknown) => {
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
  });
}

/**
 * The developers' answer applied to one feedback. Their state is applied only when it
 * changed since it was last read (kept apart, upstream_status): an admin here may move it
 * meanwhile and the next read doesn't move it back. Each public reply lands once.
 */
export async function applyUpstream(row: Feedback, item: UpstreamItem, now = new Date()): Promise<boolean> {
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

/** Reads back the developers' states and replies of what was shared. */
export async function syncStatuses(now = Date.now()): Promise<number> {
  if (!(await sharingEnabled())) return 0;
  const rows = await sentFeedback(STATUS_PER_CYCLE);
  let updated = 0;
  for (let i = 0; i < rows.length; i += STATUS_BATCH) {
    const batch = rows.slice(i, i + STATUS_BATCH);
    const path = `/feedback/status?ids=${batch.map((r) => r.uid).join(",")}`;
    let raw: unknown;
    try {
      raw = await (await callStore(path, { method: "GET", headers: signedHeaders("GET", path, "", now) })).json();
    } catch (e) {
      // The Store not there (yet), or refusing: the next cycle asks again, said in the log.
      console.warn(`[feedback] states not read back: ${e instanceof Error ? e.message : String(e)}`);
      return updated;
    }
    const byUid = new Map(batch.map((r) => [r.uid, r]));
    for (const item of readStatusAnswer(raw)) {
      const row = byUid.get(item.id);
      if (row && (await applyUpstream(row, item, new Date(now)))) updated++;
    }
  }
  return updated;
}

/** The purge cadence's step (api/boot.ts): send what is queued, read back the rest. Never throws. */
export async function runFeedbackSync(now = Date.now()): Promise<void> {
  try {
    const sent = await forwardQueued({ now });
    const updated = await syncStatuses(now);
    if (sent.sent + sent.refused + updated > 0) await recordSystem({ kind: "system", label: "feedback" }, "feedback.forward", { after: { ...sent, updated } });
  } catch (e) {
    console.warn(`[feedback] sync: ${e instanceof Error ? e.message : String(e)}`);
  }
}
