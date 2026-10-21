// What an adapter returns, held to what it declared: the binding checks
// every result (core/bind.ts) and the conformance suite asserts the same
// rules. A result that breaks one is an adapter bug: it surfaces as
// "incompatible", never as data the engine would store.
import type { EntryCapabilities, TrackerCapabilities } from "@contracts/providers";
import { ProviderError } from "./errors";
import type { ActiveWorkflowSource, FindResult, Page, PageQuery, RemoteWorklog, ReportedEntryGone, ReportedIssueGone, TrackerProbe } from "../types";

export class IncompatibleResultError extends ProviderError {
  constructor(message: string) {
    super("incompatible", `Adapter result breaks the contract: ${message}`);
    this.name = "IncompatibleResultError";
  }
}

const fail = (m: string): never => {
  throw new IncompatibleResultError(m);
};

/** One key per concrete workflow source (two active sources never share one). */
export function sourceKey(a: ActiveWorkflowSource): string {
  const r = a.ref;
  switch (r.kind) {
    case "itemState":
      return `itemState:${r.containerRemoteId ?? ""}`;
    case "projectField":
      return `projectField:${r.containerRemoteId}:${r.fieldRemoteId}`;
    case "column":
      return `column:${r.boardRemoteId}`;
    case "labelSet":
      return `labelSet:${r.containerRemoteId ?? ""}:${r.scope}`;
    case "boolean":
      return "boolean";
  }
}

/** A probe's active sources: each of a kind its capabilities declare, each once. */
export function checkActiveSources(probe: TrackerProbe): void {
  const keys = probe.activeSources.map(sourceKey);
  if (new Set(keys).size !== keys.length) fail("an active workflow source appears twice");
  for (const a of probe.activeSources) {
    if (!probe.capabilities.workflow.sources.some((s) => s.kind === a.kind && s.transitions === a.transitions)) fail(`active source ${a.kind} not among the capabilities`);
  }
}

/** A page of issues: the reasons declared, the checkpoint as the capabilities say. */
export function checkIssuePage(c: TrackerCapabilities, q: PageQuery, p: Page<unknown, ReportedIssueGone>): void {
  if (!c.sync.issueCheckpoints && q.since !== null) fail("a checkpoint given to a provider without checkpoints");
  if (p.last) {
    if (c.sync.issueCheckpoints && p.checkpoint === null) fail("the last page of a provider with checkpoints has none");
    if (!c.sync.issueCheckpoints && p.checkpoint !== null) fail("a checkpoint from a provider without checkpoints");
  }
  for (const g of p.gone) {
    const ok = g.reason === "transferred" ? c.sync.gone.transfer === "withSuccessor" : c.sync.gone[g.reason];
    if (!ok) fail(`gone "${g.reason}" not declared`);
  }
}

/** A page of entries: removals only when the feed declares them. */
export function checkEntryPage(e: EntryCapabilities, p: Page<unknown, ReportedEntryGone>): void {
  const removals = e.feed.kind === "incremental" && e.feed.removals;
  if (!removals && p.gone.length > 0) fail("removals from a feed that doesn't declare them");
}

/** An entry as read: editable only narrows, locked never editable, attributes only when declared, span as kept. */
export function checkWorklog(e: EntryCapabilities, w: RemoteWorklog): void {
  if (e.model === "entries") {
    if (w.span.kind !== e.shape) fail(`a ${w.span.kind} entry from a service keeping ${e.shape} entries`);
    const canUpdate = e.write.mode === "entry" && e.write.update !== "none";
    const canDelete = e.write.mode === "entry" && e.write.delete;
    if (w.editable.update && !canUpdate) fail("an entry editable beyond the capabilities (update)");
    if (w.editable.delete && !canDelete) fail("an entry editable beyond the capabilities (delete)");
    if (w.billable != null && !e.billable.read) fail("billable read but not declared");
    if (w.activity != null && !e.activities.read) fail("activity read but not declared");
  } else {
    if (w.span.kind !== "dayTotal") fail("an entry other than a day total from a day-totals service");
    if ((w.editable.update || w.editable.delete) && !e.write.set) fail("a day total editable on a read-only service");
  }
  if (w.locked && (w.editable.update || w.editable.delete)) fail("a locked entry marked editable");
  if (w.approval != null && !e.approvals.read) fail("approval read but not declared");
}

/** An ambiguous lookup has at least two candidates. */
export function checkFind(r: FindResult): void {
  if (r.kind === "ambiguous") {
    if (r.candidates.length < 2) fail("an ambiguous lookup with fewer than two candidates");
    if (new Set(r.candidates.map((c) => c.remoteId)).size !== r.candidates.length) fail("an ambiguous lookup listing one issue twice");
  }
}
