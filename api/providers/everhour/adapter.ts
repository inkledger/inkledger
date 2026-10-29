// Everhour as a time sink, through the provider contract. Everhour keeps one
// total per user, day and task, not individual entries: inkledger sets the
// day's total of an issue (PUT replaces, 0 removes) and reads the user's days
// back to reconcile. Tasks are named by their integration's ids ("ji:10001"),
// so an entry points back at its issue by the tracker's own id; the issue key
// and title go in the note. No change feed, no idempotency key (a replace is
// repeatable on its own). The API key stays in the credential.
// Built on a simulator, not verified on a real account: SPIKES.md.
import { z } from "zod";
import type { TimeSinkCapabilities, TimeSinkTraits, TrackerType } from "@contracts/providers";
import { instant, localDate, localDateOf } from "@contracts/values";
import { secretOf } from "../core/context";
import { ProviderError } from "../core/errors";
import { assertSeconds } from "../core/time";
import type { CallContext, ExternalRef, RemoteWorklog, TimeSinkProvider } from "../types";
import { eh, ehOk, ehPages, type EverhourCreds, type EverhourTimeRecord, type EverhourTimer, type EverhourUser } from "./client";

export const everhourSinkCapabilities: TimeSinkCapabilities = {
  entries: {
    model: "dayTotals",
    write: { set: true },
    feed: { kind: "none" },
    reconcile: { kind: "period" },
    approvals: { read: true },
    idempotency: "local",
    concurrency: "none",
    limits: {},
  },
  references: ["external"],
  target: { use: "none" },
  // Published budget and its scope (verify: everhour-rate-limit): none declared until then
};
export const everhourSinkTraits: TimeSinkTraits = { invoices: true, rates: true };

// The account is the API key's: nothing else to say.
const optionsSchema = z.strictObject({});
export type EverhourOptions = z.infer<typeof optionsSchema>;

type X = CallContext<"everhour", EverhourOptions>;

async function credsOf(x: X): Promise<EverhourCreds> {
  const cred = await x.conn.credential();
  const token = secretOf(cred);
  return { apiBase: x.conn.baseUrl, token };
}

/**
 * Everhour's task ids: the integration's two-letter prefix and the tracker's
 * own id. A tracker without one cannot be filed there (Everhour has no task
 * for it to point at).
 */
export const EVERHOUR_PREFIX: Partial<Record<TrackerType, string>> = {
  jira: "ji",
  github: "gh",
  gitlab: "gl",
  asana: "as",
  trello: "tr",
  basecamp: "b3",
  clickup: "cl",
  todoist: "td",
  wrike: "wr",
};

export function taskIdOf(ref: ExternalRef): string {
  const prefix = EVERHOUR_PREFIX[ref.trackerType];
  if (!prefix) throw new ProviderError("invalid", `Everhour has no integration for ${ref.trackerType}: time on its issues can't be filed there`);
  return `${prefix}:${ref.issue.remoteId}`;
}

/** The note of a day total: always the issue's key and title, so the entry is findable in Everhour whatever the task shows. */
export const noteOf = (ref: ExternalRef) => `${ref.issue.key}: ${ref.snapshot.title}`.slice(0, 500);

const remoteIdOf = (taskId: string, date: string) => `${taskId}@${date}`;

const PREFIXES = new Set(Object.values(EVERHOUR_PREFIX));

function toWorklog(r: EverhourTimeRecord): RemoteWorklog {
  const taskId = r.task?.id ?? "";
  const [prefix, ...rest] = taskId.split(":");
  // A task of an integration names its issue; Everhour's own tasks (ev:…) point at none.
  const issue = prefix && PREFIXES.has(prefix) && rest.length > 0 ? { remoteId: rest.join(":") } : null;
  return {
    remoteId: remoteIdOf(taskId, r.date),
    issue,
    span: { kind: "dayTotal", date: localDate(r.date), seconds: r.time },
    comment: r.comment ?? "",
    authorRemoteId: String(r.user),
    approval: r.locked ? "approved" : "none",
    locked: r.locked ? { cause: "approved", message: "The period is locked in Everhour" } : null,
    editable: { update: !r.locked, delete: !r.locked },
  };
}

export const everhourSink: TimeSinkProvider<"everhour", EverhourOptions> = {
  role: "timeSink",
  type: "everhour",
  capabilities: everhourSinkCapabilities,
  traits: everhourSinkTraits,

  parseOptions(raw) {
    const r = optionsSchema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `Everhour options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  },

  async verify(x) {
    const me = await ehOk<EverhourUser>(await credsOf(x), "/users/me");
    return { remoteId: String(me.id), name: me.name?.trim() || me.email || String(me.id), avatarUrl: me.avatarUrl ?? null, ...(me.email ? { email: me.email } : {}) };
  },

  async probe(x) {
    await ehOk<EverhourUser>(await credsOf(x), "/users/me");
    // No published budget declared (everhour-rate-limit): none reported.
    return { capabilities: everhourSinkCapabilities, verifiedAt: instant(Date.now()) };
  },

  entries: {
    async list(x, range) {
      const q = new URLSearchParams({ from: range.from, to: range.to });
      const rows = await ehPages<EverhourTimeRecord>(await credsOf(x), `/users/me/time?${q.toString()}`);
      return rows.filter((r) => r.date >= range.from && r.date <= range.to && r.time > 0).map(toWorklog);
    },

    async setDayTotal(x, ref, target, date, seconds) {
      if (target) throw new ProviderError("invalid", "Everhour files time under the issue's task, not a project/task of its own");
      assertSeconds(seconds, true);
      if (seconds > 24 * 3600) throw new ProviderError("invalid", "Everhour takes at most 24 hours a day on a task");
      const c = await credsOf(x);
      const task = taskIdOf(ref);
      // A running timer on the task adds its time when stopped, on top of what is set now: wait for the user.
      const timer = await ehOk<EverhourTimer>(c, "/timers/current");
      if (timer.status === "active" && timer.task?.id === task) {
        const started = timer.startedAt ? localDateOf(instant(Date.parse(timer.startedAt)), x.conn.timeZone) : null;
        const today = localDateOf(instant(Date.now()), x.conn.timeZone);
        if (date === started || date === today) throw new ProviderError("conflict", `Everhour has a timer running on ${task}: stop it first`);
      }
      // PUT replaces the day's time of the task; 0 removes the record.
      const done = await eh<EverhourTimeRecord | undefined>(c, `/tasks/${encodeURIComponent(task)}/time`, {
        method: "PUT",
        body: JSON.stringify({ time: seconds, date, comment: noteOf(ref) }),
        // Removing what Everhour doesn't have is done
        missingIsNull: seconds === 0,
      }).catch((e: unknown) => {
        // The task has to exist in Everhour (its project added there): not something to retry.
        if (e instanceof ProviderError && e.kind === "notFound") throw new ProviderError("invalid", `Everhour doesn't have the task ${task}: add the issue's project to Everhour first`, { status: 404 });
        throw e;
      });
      if (seconds === 0 || !done) return null;
      return toWorklog({ date, time: seconds, user: Number(x.conn.remoteAccountId) || 0, comment: noteOf(ref), ...done.data, task: { id: task } });
    },
  },
};
