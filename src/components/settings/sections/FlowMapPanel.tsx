import { useEffect, useRef, useState } from "react";
import { Download, FileUp, RefreshCw, Trash2 } from "lucide-react";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import { useWorkspace } from "@/lib/workspace/context";
import { failureText } from "@/lib/errorText";
import { cn } from "@/lib/utils";
import type { EvidenceSet, ExpectationGap, FlowMapDocument, FlowMapView } from "@contracts/workspace/flowMap";
import { CATALOG_V1 } from "@contracts/workspace/catalogV1";
import type { SuggestionPatch } from "@contracts/workspace/model";
import { t, type MessageKey } from "@/i18n";
import { areaLabel, controlLabel, periodLabel } from "@/lib/workspace/labels";
import { HeatTimeline } from "./HeatTimeline";

const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;

export default function FlowMapPanel({ onPatch }: { onPatch: (patch: SuggestionPatch) => Promise<void> }) {
  const { scope, workspace } = useWorkspace();
  const utils = trpc.useUtils();
  const query = trpc.flowMap.get.useQuery({ scope });
  const consent = trpc.flowMap.consent.useMutation();
  const aggregate = trpc.flowMap.aggregate.useMutation();
  const exportMap = trpc.flowMap.export.useMutation();
  const importMap = trpc.flowMap.import.useMutation();
  const feedback = trpc.flowMap.feedback.useMutation();
  const deleteData = trpc.flowMap.delete.useMutation();
  const [view, setView] = useState<FlowMapView>("heat");
  const [preview, setPreviewState] = useState<{ contents: string; document: FlowMapDocument; filename: string; imageUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The picture's URL is made when a preview is chosen and revoked when it is replaced or the panel goes.
  const imageUrl = useRef<string | null>(null);
  const setPreview = (next: { contents: string; document: FlowMapDocument; filename: string } | null) => {
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = next ? URL.createObjectURL(new Blob([next.document.svg], { type: "image/svg+xml" })) : null;
    setPreviewState(next && imageUrl.current ? { ...next, imageUrl: imageUrl.current } : null);
  };
  useEffect(() => () => { if (imageUrl.current) URL.revokeObjectURL(imageUrl.current); }, []);
  const busy = consent.isPending || aggregate.isPending || exportMap.isPending || importMap.isPending || feedback.isPending || deleteData.isPending;

  const refresh = async () => {
    await Promise.all([utils.flowMap.get.invalidate({ scope }), utils.flowMap.settings.invalidate(), utils.settings.get.invalidate()]);
  };
  const run = async (action: () => Promise<void>) => {
    setError(null);
    try { await action(); } catch (cause) { setError(failureText(cause)); }
  };
  const prepare = async (evidenceId: string) => {
    await run(async () => {
      const result = await exportMap.mutateAsync({ scope, evidenceId, view });
      setPreview({ contents: result.contents, document: JSON.parse(result.contents) as FlowMapDocument, filename: result.filename });
    });
  };
  const download = () => {
    if (!preview) return;
    const url = URL.createObjectURL(new Blob([preview.contents], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = preview.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const expectationTarget = (gap: ExpectationGap) => {
    const control = gap.destinationControlId && CATALOG_V1.controls.find(item => item.id === gap.destinationControlId);
    const anchor = control && CATALOG_V1.anchors.find(item => item.id === control.anchorId && item.surfaceId === scope.surfaceId);
    const placement = anchor && workspace.placements.find(item => item.anchorId === anchor.id);
    const area = anchor && CATALOG_V1.areas.find(item => item.id === gap.areaId && item.surfaceId === scope.surfaceId);
    if (!anchor || !placement || !area || !area.allowedAnchorIds.includes(anchor.id)) return null;
    if (placement.areaId !== area.id && (anchor.statePolicy === "local" || !anchor.studio.operations.includes("move"))) return null;
    return { anchor, placement, area };
  };
  const previewExpectation = async (evidence: EvidenceSet, gap: ExpectationGap) => {
    const target = expectationTarget(gap);
    if (!target || gap.state !== "confirmed") return;
    const patchId = `patch_${crypto.randomUUID()}`;
    const { anchor, placement, area } = target;
    await run(() => onPatch({
      patchId,
      patchSchemaVersion: 1,
      scope,
      baseRevision: workspace.sourceActiveRevision,
      catalogVersion: workspace.catalogVersion,
      author: "user",
      provenance: {},
      intent: { kind: "expectHere", status: "explicit", anchorId: anchor.id, areaId: area.id },
      operations: placement.areaId === area.id ? [] : [{ type: "move", operationId: `op_${crypto.randomUUID()}`, anchorId: anchor.id, toAreaId: area.id }],
      evidence: [{ evidenceId: evidence.evidenceId, effectiveRevision: evidence.descriptor.effectiveRevision }],
      proposedConstraints: [{ id: `constraint_${crypto.randomUUID()}`, kind: "expectHere", status: "explicit", author: "user", scope, anchorId: anchor.id, areaId: area.id }],
    }));
  };
  // Controls and areas by their names, counts in words: never a catalogue id on screen.
  const rows = (evidence: EvidenceSet) => view === "heat"
    ? evidence.heat.map(point => ({ id: point.controlId, label: controlLabel(point.controlId), detail: t(key("heatDetail"), { count: point.activations, exposures: point.exposures, failures: point.failures }) }))
    : view === "flow"
      ? evidence.flows.map(edge => ({ id: `${edge.fromControlId}>${edge.toControlId}`, label: `${controlLabel(edge.fromControlId)} → ${controlLabel(edge.toControlId)}`, detail: String(edge.count) }))
      : view === "friction"
        ? evidence.friction.map(point => ({ id: point.controlId, label: controlLabel(point.controlId), detail: t(key("frictionDetail"), { abandoned: point.abandoned, failures: point.failures, backtracks: point.backtracks }) }))
        : evidence.expectations.map(gap => ({
          id: gap.id,
          label: `${t(key(`patterns.${gap.pattern}`), { area: areaLabel(gap.areaId) })}${gap.destinationControlId ? ` → ${controlLabel(gap.destinationControlId)}` : ""}`,
          detail: t(key("expectationDetail"), { count: gap.occurrences, confidence: Math.round(gap.confidence * 100), state: t(key(`expectationStates.${gap.state}`)) }),
        }));
  // Nothing used yet: no dates to show (an empty set has none), only that it is empty.
  const period = (coverage: EvidenceSet["coverage"]) => coverage.lastAt > 0
    ? t(key("evidenceRange"), { range: periodLabel(coverage), count: coverage.activeDays })
    : t(key("evidenceEmpty"));
  return (
    <SettingsGroup id="workspace-flowmap" title={t(key("flowTitle"))} description={t(key("flowDescription"))}>
      {error && <p role="alert" className="mb-3 text-body-sm text-danger">{error}</p>}
      <SettingsRow label={t(key("consent"))} hint={t(key("consentHint"))} inline>
        <Checkbox aria-label={t(key("consent"))} checked={query.data?.settings.enabled ?? false} disabled={busy} onCheckedChange={checked => void run(async () => {
          await consent.mutateAsync({ enabled: checked === true });
          setPreview(null);
          await refresh();
        })} />
      </SettingsRow>
      {(query.data?.settings.enabled || (query.data?.evidence.length ?? 0) > 0) && (
        <HeatTimeline evidence={query.data?.evidence ?? []} layouts={query.data?.layouts ?? {}} scope={scope} />
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <SegmentedControl label={t(key("view"))} value={view} onChange={setView} options={(["heat", "flow", "friction", "expectation"] as const).map(value => ({ value, label: t(key(`views.${value}`)) }))} />
        <Button variant="outline" size="sm" disabled={busy || !query.data?.settings.enabled} onClick={() => void run(async () => { await aggregate.mutateAsync({ scope }); await refresh(); })}>
          <RefreshCw className="h-4 w-4" />{t(key("generate"))}
        </Button>
      </div>
      {query.data?.evidence.map(evidence => (
        <section key={evidence.evidenceId} aria-label={period(evidence.coverage)} className="mt-4 border-t pt-3">
          <p className="text-body-sm font-medium tabular-nums">{period(evidence.coverage)}</p>
          <p className="text-caption text-muted-foreground">{t(key("coverage"), { days: evidence.coverage.activeDays, gaps: evidence.coverage.gaps })}</p>
          <table className="mt-3 w-full text-left text-body-sm">
            <caption className="sr-only">{t(key("accessibleMap"))}</caption>
            <thead><tr className="text-caption text-muted-foreground"><th scope="col">{t(key("control"))}</th><th scope="col">{t(key("observed"))}</th></tr></thead>
            <tbody>{rows(evidence).map(row => <tr key={row.id} className="border-t"><th scope="row" className="min-w-0 py-2 pr-3 font-normal [overflow-wrap:anywhere]">{row.label}</th><td className="py-2 tabular-nums">{row.detail}</td></tr>)}</tbody>
          </table>
          {view === "expectation" && evidence.expectations.length > 0 && <p className="text-caption text-muted-foreground">{t(key("expectationHint"))}</p>}
          {view === "expectation" && evidence.expectations.map(gap => <div key={gap.id} className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} aria-label={`${t(key("confirmExpectation"))}: ${areaLabel(gap.areaId)}`} onClick={() => void run(async () => { await feedback.mutateAsync({ scope, expectationId: gap.id, status: "confirmed" }); await refresh(); })}>{t(key("confirmExpectation"))}</Button>
            <Button size="sm" variant="ghost" disabled={busy} aria-label={`${t(key("rejectExpectation"))}: ${areaLabel(gap.areaId)}`} onClick={() => void run(async () => { await feedback.mutateAsync({ scope, expectationId: gap.id, status: "rejected" }); await refresh(); })}>{t(key("rejectExpectation"))}</Button>
            {gap.state === "confirmed" && expectationTarget(gap) && <Button size="sm" disabled={busy} onClick={() => void previewExpectation(evidence, gap)}>{t(key("useExpectation"))}</Button>}
          </div>)}
          <Button className="mt-3" size="sm" variant="outline" disabled={busy} onClick={() => void prepare(evidence.evidenceId)}>{t(key("previewFile"))}</Button>
        </section>
      ))}
      {query.data?.imports.map(item => <section key={item.importId} className="mt-4 border-t pt-3">
        <p className="text-body-sm font-medium">{t(key("importedEvidence"))}</p>
        <p className="text-caption text-muted-foreground tabular-nums">{period(item.document.evidence.coverage)}</p>
        <Button className="mt-2" size="sm" variant="outline" disabled={busy} onClick={() => setPreview({ contents: JSON.stringify(item.document), document: item.document, filename: `import-${item.importId}.flowmap` })}>{t(key("previewFile"))}</Button>
      </section>)}
      {preview && <section className="mt-4 border-t pt-3" aria-label={t(key("previewFile"))}>
        <img src={preview.imageUrl} alt={t(key("previewAlt"))} className="max-h-96 w-full rounded-md border object-contain" />
        <p className="mt-2 text-caption text-muted-foreground">{t(key("downloadHint"))}</p>
        <Button className="mt-2" size="sm" onClick={download}><Download className="h-4 w-4" />{t(key("download"))}</Button>
      </section>}
      <div className="mt-5 flex flex-wrap gap-2 border-t pt-4">
        <Button variant="outline" size="sm" asChild>
          <label className={cn("cursor-pointer focus-within:ring-2 focus-within:ring-ring", busy && "pointer-events-none opacity-50")}><FileUp className="h-4 w-4" />{t(key("import"))}<Input type="file" accept=".flowmap,application/json" className="sr-only" aria-label={t(key("import"))} disabled={busy} onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void run(async () => {
              const result = await importMap.mutateAsync({ contents: await file.text() });
              setPreview({ contents: JSON.stringify(result.document), document: result.document, filename: `import-${result.importId}.flowmap` });
              await refresh();
            });
          }} /></label>
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild><Button variant="ghost" size="sm" disabled={busy}><Trash2 className="h-4 w-4" />{t(key("delete"))}</Button></AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader><AlertDialogTitle>{t(key("delete"))}</AlertDialogTitle><AlertDialogDescription>{t(key("deleteDescription"))}</AlertDialogDescription></AlertDialogHeader>
            <AlertDialogFooter><AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel><AlertDialogAction destructive onClick={() => void run(async () => { await deleteData.mutateAsync(); setPreview(null); await refresh(); })}>{t(key("deleteConfirm"))}</AlertDialogAction></AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      <p className="mt-2 text-caption text-muted-foreground">{t(key("importHint"))}</p>
    </SettingsGroup>
  );
}
