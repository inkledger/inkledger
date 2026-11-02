import { useState } from "react";
import { Download, FileUp, Sparkles } from "lucide-react";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/lib/workspace/context";
import { failureText } from "@/lib/errorText";
import type { Ranking } from "@contracts/workspace/planner";
import type { Draft, ResolvedWorkspace, SuggestionPatch } from "@contracts/workspace/model";
import type { WorkspaceDocument } from "@contracts/workspace/portability";
import { dateFormat, numberFormat, t, type MessageKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { anchorLabel, areaLabel } from "@/lib/workspace/labels";
import { downloadBlob } from "@/lib/download";
import { dayMonth } from "@/lib/dates";

type Candidate = { patch: SuggestionPatch; preview: ResolvedWorkspace; reason: string; ranking: Ranking; adaptationWindowDays: number };
const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;
/** Ranking values: a share or a score, at most two decimals, written the user's way. */
const score = (value: number) => numberFormat({ maximumFractionDigits: 2 }).format(value);
const rate = () => numberFormat({ minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A proposed change in words: what moves, where, never its ids. */
function operationText(operation: SuggestionPatch["operations"][number]): string {
  const anchor = operation.type === "reorder" ? "" : anchorLabel(operation.anchorId);
  if (operation.type === "move") return t(key("operationText.move"), { anchor, area: areaLabel(operation.toAreaId) });
  // The order itself: two reorders of one area are two different proposals, and must read so.
  if (operation.type === "reorder") return t(key("operationText.reorder"), { area: areaLabel(operation.areaId), order: operation.anchorIds.map(id => anchorLabel(id)).join(", ") });
  if (operation.type === "variant") return t(key("operationText.variant"), { anchor, variant: t(key(`variants.${operation.variant}`)) });
  if (operation.type === "visibility") return t(key(operation.visible ? "operationText.show" : "operationText.hide"), { anchor });
  return t(key(operation.pinned ? "operationText.pin" : "operationText.unpin"), { anchor });
}

type EvidenceSummary = { evidenceId: string; coverage: { firstAt: number; lastAt: number; activeDays: number } };

/** Evidence named by when it was collected, never by its internal id. */
function evidenceLabel(evidence: EvidenceSummary): string {
  const range = `${dayMonth(evidence.coverage.firstAt)} – ${dayMonth(evidence.coverage.lastAt)}`;
  return t(key("evidenceRange"), { range, count: evidence.coverage.activeDays });
}

function EvidencePicker({ label, value, evidence, disabled, onChange }: { label: string; value: string; evidence: readonly EvidenceSummary[]; disabled: boolean; onChange: (id: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger disabled={disabled} aria-label={label} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        {evidence.map(item => <SelectItem key={item.evidenceId} value={item.evidenceId}>{evidenceLabel(item)}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export default function PlannerPanel({ draft, onPatch, onRestore }: {
  draft: Draft | null;
  onPatch: (patch: SuggestionPatch) => Promise<void>;
  onRestore: (draft: Draft, descriptor: string, workspace: ResolvedWorkspace) => void;
}) {
  const { scope, workspace } = useWorkspace();
  const suggest = trpc.planner.suggest.useMutation();
  const interpret = trpc.planner.interpret.useMutation();
  const suppress = trpc.planner.suppress.useMutation();
  const exportDocument = trpc.planner.export.useMutation();
  const importDocument = trpc.planner.import.useMutation();
  const confirmConstraint = trpc.planner.confirmConstraint.useMutation();
  const evidenceQuery = trpc.flowMap.get.useQuery({ scope });
  const [suggestions, setSuggestions] = useState<Candidate[]>([]);
  const [requestText, setRequestText] = useState("");
  const [requestCandidate, setRequestCandidate] = useState<{ patch: SuggestionPatch; preview: ResolvedWorkspace } | null>(null);
  const [clarification, setClarification] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [picked, setPicked] = useState<{ before: string; after: string }>({ before: "", after: "" });
  const [reviewed, setReviewed] = useState<{ pair: string; outcome: "improved" | "worsened" | "inconclusive"; confounds: string[]; beforeRate?: number; afterRate?: number } | null>(null);
  // The pair follows the evidence: a pick that no longer exists falls back to the two latest.
  const evidenceList = evidenceQuery.data?.evidence ?? [];
  const hasPair = evidenceList.length >= 2;
  const beforeId = !hasPair ? "" : evidenceList.some(item => item.evidenceId === picked.before) ? picked.before : evidenceList[1].evidenceId;
  const afterId = !hasPair ? "" : evidenceList.some(item => item.evidenceId === picked.after) ? picked.after : evidenceList[0].evidenceId;
  const review = reviewed?.pair === `${beforeId}|${afterId}` ? reviewed : null;
  const evaluate = trpc.planner.evaluate.useQuery({ scope, beforeEvidenceId: beforeId, afterEvidenceId: afterId }, { enabled: false });
  const [exported, setExported] = useState<{ contents: string; document: WorkspaceDocument } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = suggest.isPending || interpret.isPending || suppress.isPending || exportDocument.isPending || importDocument.isPending || confirmConstraint.isPending || evaluate.isFetching;
  const run = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (cause) { setError(failureText(cause)); }
  };
  const compare = () => void run(async () => {
    const result = await evaluate.refetch();
    if (result.error) {
      setError(failureText(result.error));
      return;
    }
    if (result.data) setReviewed({ pair: `${beforeId}|${afterId}`, ...result.data });
  });
  const generate = (enrichAI: boolean) => void run(async () => {
    const result = await suggest.mutateAsync({ scope, enrichAI });
    setNotice(null);
    if (result.status === "insufficient-evidence") {
      setSuggestions([]);
      setNotice(t(key("insufficient"), { days: result.actual.activeDays, count: result.actual.activations }));
      return;
    }
    setSuggestions(result.suggestions);
    setSelected(current => ({ ...current, ...Object.fromEntries(result.suggestions.map(candidate => [candidate.patch.patchId, candidate.patch.operations.map(operation => operation.operationId)])) }));
    if (result.ai === "unavailable") setNotice(t(key("aiUnavailable")));
    else if (result.ai === "none") setNotice(t(key("aiNone")));
  });
  const interpretRequest = () => void run(async () => {
    setNotice(null);
    setClarification(null);
    setRequestCandidate(null);
    const result = await interpret.mutateAsync({ scope, originalText: requestText });
    // Only a request turned into a change is done with; anything else keeps what the user typed.
    if (result.status === "ready") {
      setRequestText("");
      setRequestCandidate({ patch: result.patch, preview: result.preview });
      setSelected(current => ({ ...current, [result.patch.patchId]: result.patch.operations.map(operation => operation.operationId) }));
    } else if (result.status === "clarify") setClarification(result.question);
    else setNotice(t(key(result.status === "invalid" ? "requestInvalid" : "requestUnavailable")));
  });
  const accept = async (candidate: { patch: SuggestionPatch }) => {
    const ids = selected[candidate.patch.patchId] ?? [];
    const operations = candidate.patch.operations.filter(operation => ids.includes(operation.operationId));
    if (operations.length === 0) return;
    await onPatch({
      ...candidate.patch,
      patchId: `patch_${crypto.randomUUID()}`,
      author: "user",
      provenance: { ...candidate.patch.provenance, parentPatchId: candidate.patch.patchId },
      intent: { ...candidate.patch.intent, status: "explicit" },
      operations,
      suggestionSignature: undefined,
    });
  };
  const acceptRequest = async () => {
    if (!requestCandidate) return;
    await accept(requestCandidate);
    setRequestCandidate(null);
  };
  const download = () => {
    if (!exported) return;
    downloadBlob(`workspace-${scope.surfaceId}.workspace`, new Blob([exported.contents], { type: "application/json" }));
  };
  return (
    <SettingsGroup id="workspace-planner" title={t(key("plannerTitle"))} description={t(key("plannerDescription"))}>
      {error && <p role="alert" className="mb-3 text-body-sm text-danger">{error}</p>}
      {notice && <p role="status" className="mb-3 text-body-sm text-muted-foreground">{notice}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => generate(false)}>{t(key("suggest"))}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => generate(true)}><Sparkles className="h-4 w-4" />{t(key("suggestAI"))}</Button>
      </div>
      <section className="mt-4 border-t pt-3" aria-label={t(key("requestPreview"))}>
        <label htmlFor="workspace-request" className="text-body-sm font-medium">{t(key("requestLabel"))}</label>
        <Textarea id="workspace-request" className="mt-2" rows={3} maxLength={2_000} disabled={busy} value={requestText} aria-describedby={clarification ? "workspace-request-clarification" : "workspace-request-hint"} onChange={event => { setRequestText(event.target.value); setClarification(null); }} />
        <p id="workspace-request-hint" className="mt-1 text-caption text-muted-foreground">{t(key("requestHint"))}</p>
        <Button className="mt-2" size="sm" variant="outline" disabled={busy || !requestText.trim()} onClick={interpretRequest}><Sparkles className="h-4 w-4" />{t(key("requestTranslate"))}</Button>
        {clarification && <p id="workspace-request-clarification" role="status" className="mt-2 text-body-sm">{clarification}</p>}
      </section>
      {requestCandidate && <article className="mt-4 border-t pt-3">
        <h4 className="text-body-sm font-medium">{t(key("requestPreview"))}</h4>
        <div className="mt-2 grid gap-2">{requestCandidate.patch.operations.map(operation => <label key={operation.operationId} className="flex items-start gap-2 text-body-sm">
          <Checkbox checked={(selected[requestCandidate.patch.patchId] ?? []).includes(operation.operationId)} onCheckedChange={checked => setSelected(current => ({ ...current, [requestCandidate.patch.patchId]: checked === true ? [...(current[requestCandidate.patch.patchId] ?? []), operation.operationId] : (current[requestCandidate.patch.patchId] ?? []).filter(id => id !== operation.operationId) }))} />
          <span>{operationText(operation)}</span>
        </label>)}</div>
        <p className="mt-3 text-caption text-muted-foreground">{t(key("resolvedChanges"))}</p>
        <ul className="mt-1 grid gap-1 text-caption">{requestCandidate.preview.placements.filter(placement => {
          const before = workspace.placements.find(item => item.anchorId === placement.anchorId);
          return !before || before.areaId !== placement.areaId || before.order !== placement.order || before.variant !== placement.variant || before.visible !== placement.visible || before.pinned !== placement.pinned;
        }).map(placement => <li key={placement.anchorId}>{t(key("changeText"), { anchor: anchorLabel(placement.anchorId), area: areaLabel(placement.areaId), variant: t(key(`variants.${placement.variant}`)), visibility: t(key(placement.visible ? "visible" : "hidden")) })}</li>)}</ul>
        {requestCandidate.patch.proposedConstraints.length > 0 && <p className="mt-2 text-caption text-muted-foreground">{t(key("constraintConfirmation"))}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || (selected[requestCandidate.patch.patchId] ?? []).length === 0} onClick={() => void run(acceptRequest)}>{t(key("addDraft"))}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRequestCandidate(null)}>{t(key("notNow"))}</Button>
        </div>
      </article>}
      {suggestions.map(candidate => <article key={candidate.patch.patchId} className="mt-4 border-t pt-3">
        <h4 className="text-body-sm font-medium">{t(key(`reasons.${candidate.reason}`))}</h4>
        <p className="mt-1 text-caption text-muted-foreground">{t(key("watchDays"), { count: candidate.adaptationWindowDays })}</p>
        <div className="mt-2 grid gap-2">{candidate.patch.operations.map(operation => <label key={operation.operationId} className="flex items-start gap-2 text-body-sm">
          <Checkbox checked={(selected[candidate.patch.patchId] ?? []).includes(operation.operationId)} onCheckedChange={checked => setSelected(current => ({ ...current, [candidate.patch.patchId]: checked === true ? [...(current[candidate.patch.patchId] ?? []), operation.operationId] : (current[candidate.patch.patchId] ?? []).filter(id => id !== operation.operationId) }))} />
          <span>{operationText(operation)}</span>
        </label>)}</div>
        <dl className="mt-3 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-4 gap-y-1 text-caption sm:grid-cols-[repeat(4,minmax(0,1fr))]">
          <div><dt className="text-muted-foreground">{t(key("benefit"))}</dt><dd className="tabular-nums">{score(candidate.ranking.benefit.minimum)}–{score(candidate.ranking.benefit.maximum)}</dd></div>
          <div><dt className="text-muted-foreground">{t(key("evidenceQuality"))}</dt><dd className="tabular-nums">{score(candidate.ranking.evidenceQuality)}</dd></div>
          <div><dt className="text-muted-foreground">{t(key("relearning"))}</dt><dd className="tabular-nums">{score(candidate.ranking.relearningCost)}</dd></div>
          <div><dt className="text-muted-foreground">{t(key("instability"))}</dt><dd className="tabular-nums">{score(candidate.ranking.instability)}</dd></div>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || (selected[candidate.patch.patchId] ?? []).length === 0} onClick={() => void run(() => accept(candidate))}>{t(key("addDraft"))}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSuggestions(current => current.filter(item => item.patch.patchId !== candidate.patch.patchId))}>{t(key("notNow"))}</Button>
          <Button size="sm" variant="ghost" disabled={busy || !candidate.patch.suggestionSignature} onClick={() => void run(async () => {
            if (!candidate.patch.suggestionSignature) return;
            await suppress.mutateAsync({ signature: candidate.patch.suggestionSignature });
            setSuggestions(current => current.filter(item => item.patch.patchId !== candidate.patch.patchId));
          })}>{t(key("doNotSuggest"))}</Button>
        </div>
      </article>)}
      {draft && draft.patches.some(patch => patch.proposedConstraints.some(constraint => constraint.status === "proposed")) && <section className="mt-4 border-t pt-3">
        <p className="text-body-sm text-muted-foreground">{t(key("constraintConfirmation"))}</p>
        {draft.patches.flatMap(patch => patch.proposedConstraints.filter(constraint => constraint.status === "proposed").map(constraint => {
          const rule = t(key(`ruleText.${constraint.kind}`), { anchor: anchorLabel(constraint.anchorId), area: constraint.areaId ? areaLabel(constraint.areaId) : "" });
          return <div key={constraint.id} className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-body-sm">{rule}</span>
          <Button size="sm" variant="outline" disabled={busy} aria-label={`${t(key("confirmConstraint"))}: ${rule}`} onClick={() => void run(async () => {
            const result = await confirmConstraint.mutateAsync({ scope, patchId: patch.patchId, constraintId: constraint.id });
            onRestore(result.draft, result.preview.descriptor.effectiveRevision, result.preview.workspace);
          })}>{t(key("confirmConstraint"))}</Button>
        </div>;
        }))}
      </section>}
      <section id="workspace-adaptation" className="mt-5 border-t pt-4" aria-label={t(key("adaptationTitle"))}>
        <h4 className="text-body-sm font-medium">{t(key("adaptationTitle"))}</h4>
        <p className="mt-1 text-caption text-muted-foreground">{t(key("adaptationDescription"))}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-body-sm">{t(key("beforeEvidence"))}
            <EvidencePicker label={t(key("beforeEvidence"))} value={beforeId} evidence={evidenceList} disabled={busy || !hasPair} onChange={before => setPicked(current => ({ ...current, before }))} />
          </label>
          <label className="grid gap-1 text-body-sm">{t(key("afterEvidence"))}
            <EvidencePicker label={t(key("afterEvidence"))} value={afterId} evidence={evidenceList} disabled={busy || !hasPair} onChange={after => setPicked(current => ({ ...current, after }))} />
          </label>
        </div>
        <Button className="mt-3" size="sm" variant="outline" disabled={busy || !beforeId || !afterId || beforeId === afterId} onClick={compare}>{t(key("compareAdaptations"))}</Button>
        {(evidenceQuery.data?.evidence.length ?? 0) < 2 && <p className="mt-2 text-caption text-muted-foreground">{t(key("insufficientComparison"))}</p>}
        {review && <div role="status" className="mt-3 rounded-md border p-3">
          <p className="text-body-sm font-medium">{t(key(`outcomes.${review.outcome}`))}</p>
          {review.beforeRate !== undefined && review.afterRate !== undefined && <p className="mt-1 text-caption">{t(key("stepsPerSuccess"), { before: rate().format(review.beforeRate), after: rate().format(review.afterRate) })}</p>}
          <ul className="mt-2 grid gap-1 text-caption text-muted-foreground">{review.confounds.map(confound => <li key={confound}>{t(key(`confounds.${confound}`))}</li>)}</ul>
        </div>}
      </section>
      <div className="mt-5 flex flex-wrap gap-2 border-t pt-4">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          const result = await exportDocument.mutateAsync({ scope });
          setExported({ contents: result.contents, document: JSON.parse(result.contents) as WorkspaceDocument });
        })}>{t(key("exportWorkspace"))}</Button>
        <Button size="sm" variant="ghost" asChild><label className={cn("cursor-pointer focus-within:ring-2 focus-within:ring-ring", busy && "pointer-events-none opacity-50")}><FileUp className="h-4 w-4" />{t(key("importWorkspace"))}<Input className="sr-only" type="file" accept=".workspace,application/json" aria-label={t(key("importWorkspace"))} disabled={busy} onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void run(async () => {
            const result = await importDocument.mutateAsync({ scope, contents: await file.text() });
            if (result.preview) onRestore(result.preview.draft, result.preview.preview.descriptor.effectiveRevision, result.preview.preview.workspace);
            setNotice(result.unknownContent ? t(key("unknownContent")) : t(key("importQuarantined")));
          });
        }} /></label></Button>
      </div>
      <p className="mt-2 text-caption text-muted-foreground">{t(key("workspaceImportHint"))}</p>
      {exported && <section className="mt-3">
        <Textarea readOnly aria-label={t(key("exportWorkspace"))} value={exported.contents} className="min-h-32 text-caption" />
        <p className="mt-1 text-caption text-muted-foreground">{t(key("exportSummary"), { when: dateFormat({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(exported.document.exportedAt), count: exported.document.draft?.patches.length ?? 0 })}</p>
        <Button className="mt-2" size="sm" onClick={download}><Download className="h-4 w-4" />{t(key("downloadWorkspace"))}</Button>
      </section>}
    </SettingsGroup>
  );
}
