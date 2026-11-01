import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";

const FlowMapPanel = lazy(() => import("./FlowMapPanel"));
const PlannerPanel = lazy(() => import("./PlannerPanel"));
import { ArrowDown, ArrowUp, Eye, EyeOff, Pin, RotateCcw } from "lucide-react";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { ActionRow } from "@/components/app/ActionRow";
import { Chip } from "@/components/app/Chip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkspaceScopeProvider } from "@/lib/workspace/provider";
import { useWorkspace } from "@/lib/workspace/context";
import { draftFromWorkspace, movePatch, pinPatch, reorderPatch, variantPatch, visibilityPatch } from "@/lib/workspace/draft";
import { assessWorkspaceDrop } from "@/lib/workspace/drag";
import { areaLabel, inPageOrder } from "@/lib/workspace/labels";
import { CATALOG_V1, PRODUCT_DEFAULTS_V1 } from "@contracts/workspace/catalogV1";
import { productDefaultFor } from "@contracts/workspace/catalog";
import type { Draft, ResolvedWorkspace, Scope, SuggestionPatch, SurfaceId } from "@contracts/workspace/model";
import { failureText } from "@/lib/errorText";
import { dateFormat, t, type MessageKey } from "@/i18n";

const scopes: { value: SurfaceId; label: string }[] = [
  { value: "dashboard", label: t("settings.categories.workspace.dashboard") },
  { value: "shell-desktop", label: t("settings.categories.workspace.shell") },
  { value: "mobile-tabs", label: t("settings.categories.workspace.mobile") },
];

type Pending = { draft: Draft; descriptor: string; workspace: ResolvedWorkspace | null };


const savedAt = () => dateFormat({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function WorkspaceSection() {
  const [surfaceId, setSurfaceId] = useState<SurfaceId>("dashboard");
  const scope: Scope = { surfaceId, deviceClass: surfaceId === "mobile-tabs" ? "mobile" : "desktop" };
  return (
    <div className="contents">
      <SettingsGroup id="workspace-scope" title={t("settings.categories.workspace.scope")} description={t("settings.categories.workspace.scopeHint")}>
        <SegmentedControl label={t("settings.categories.workspace.scope")} value={surfaceId} onChange={setSurfaceId} options={scopes} />
      </SettingsGroup>
      <WorkspaceScopeProvider key={surfaceId} scope={scope} live>
        <WorkspaceEditor />
      </WorkspaceScopeProvider>
    </div>
  );
}

function WorkspaceEditor() {
  const { workspace, revisions, actions, draft: restoredDraft, draftDescriptor, draftWorkspace, presentationStatus, pendingActivation, constraints } = useWorkspace();
  const [localPending, setLocalPending] = useState<Pending | null>(null);
  const [completedDraftId, setCompletedDraftId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "Applying" only while a layout is being applied; a preview being saved says so instead.
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragged, setDragged] = useState<{ anchorId: string; areaId: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const lastActionAnchor = useRef<string | undefined>(undefined);
  const restoreFocus = useRef<string | null | undefined>(undefined);
  const previewQueue = useRef<Promise<void>>(Promise.resolve());
  const latestDraft = useRef<Draft | null>(null);
  const queuedPreviews = useRef(0);
  const anchors = useMemo(() => new Map(CATALOG_V1.anchors.map(anchor => [anchor.id, anchor] as const)), []);
  const areas = useMemo(() => inPageOrder(CATALOG_V1.areas.filter(area => area.surfaceId === workspace.scope.surfaceId)), [workspace.scope.surfaceId]);
  const restoredPending = restoredDraft && restoredDraft.draftId !== completedDraftId ? { draft: restoredDraft, descriptor: draftDescriptor?.effectiveRevision ?? "conflict", workspace: draftWorkspace } : null;
  const pending = restoredPending && (!localPending || restoredPending.draft.draftRevision > localPending.draft.draftRevision) ? restoredPending : localPending;
  const editingWorkspace = pending?.workspace ?? workspace;
  const placements = useMemo(() => [...editingWorkspace.placements].sort((a, b) => (a.areaId < b.areaId ? -1 : a.areaId > b.areaId ? 1 : 0) || a.order - b.order || (a.anchorId < b.anchorId ? -1 : 1)), [editingWorkspace]);
  const setPending = setLocalPending;
  const visibleError = error ?? (restoredDraft && !draftDescriptor ? t("settings.categories.workspace.conflict") : null);

  useEffect(() => {
    if (busy || restoreFocus.current === undefined) return;
    const active = document.activeElement;
    if (active !== document.body && !(active instanceof HTMLButtonElement && active.disabled)) return;
    const anchor = restoreFocus.current ? [...document.querySelectorAll("[data-anchor]")].find(element => element.getAttribute("data-anchor") === restoreFocus.current) : undefined;
    const control = anchor?.querySelector<HTMLElement>("button:not([disabled]), [role='checkbox']:not([disabled]), [role='combobox']:not([disabled])");
    (control ?? document.getElementById("workspace-reset"))?.focus({ preventScroll: true });
    restoreFocus.current = undefined;
  }, [busy, pending]);

  const preview = (patch: Parameters<typeof draftFromWorkspace>[1][number]): Promise<void> => {
    const operation = patch.operations[0];
    if (operation?.type !== "reorder") lastActionAnchor.current = patch.operations.length === 1 ? operation?.anchorId : undefined;
    const displayed = pending?.draft ?? restoredDraft;
    const previous = latestDraft.current && (!displayed || latestDraft.current.draftRevision >= displayed.draftRevision) ? latestDraft.current : displayed;
    const draft = draftFromWorkspace(workspace, [patch], previous);
    latestDraft.current = draft;
    queuedPreviews.current++;
    setBusy(true);
    setError(null);
    const save = async () => {
      try {
        const result = await actions.saveDraft(draft);
        if (latestDraft.current === draft) {
          latestDraft.current = result.draft;
          setPending({ draft: result.draft, descriptor: result.preview.descriptor.effectiveRevision, workspace: result.preview.workspace });
        }
      } catch (e) {
        if (latestDraft.current === draft) setError(failureText(e));
      } finally {
        queuedPreviews.current--;
        if (queuedPreviews.current === 0) setBusy(false);
      }
    };
    previewQueue.current = previewQueue.current.then(save);
    return previewQueue.current;
  };

  const apply = async () => {
    if (!pending) return;
    setBusy(true);
    setApplying(true);
    setError(null);
    try {
      const result = await actions.applyDraft(pending.draft);
      if (result.status === "applied") {
        restoreFocus.current = lastActionAnchor.current ?? null;
        latestDraft.current = null;
        setCompletedDraftId(pending.draft.draftId);
        setPending(null);
      } else if (result.status === "conflict") setError(t("settings.categories.workspace.conflict"));
      else if (result.status === "deferred") setError(t("settings.categories.workspace.deferred"));
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
      setApplying(false);
    }
  };

  const recover = async () => {
    if (!pendingActivation) return;
    setBusy(true);
    setError(null);
    try {
      const result = await actions.reconcile({
        effectiveRevision: pendingActivation.descriptor.effectiveRevision,
        workspaceFingerprint: pendingActivation.descriptor.workspaceFingerprint,
        presentationEpoch: pendingActivation.presentationEpoch,
      }, pending?.draft.draftId);
      if (result.status === "deferred") {
        setError(t("settings.categories.workspace.deferred"));
        return;
      }
      restoreFocus.current = null;
      latestDraft.current = null;
      if (pending?.draft.draftId) setCompletedDraftId(pending.draft.draftId);
      setPending(null);
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await actions.discardDraft(pending.draft.draftId);
      latestDraft.current = null;
      setCompletedDraftId(pending.draft.draftId);
      setPending(null);
      document.getElementById("workspace-reset")?.focus({ preventScroll: true });
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    const defaults = productDefaultFor(PRODUCT_DEFAULTS_V1, workspace.scope.surfaceId).placements;
    const patches: SuggestionPatch[] = [];
    for (const placement of editingWorkspace.placements) {
      const wanted = defaults.find(item => item.anchorId === placement.anchorId);
      if (wanted) {
        if (placement.areaId !== wanted.areaId) patches.push(movePatch(workspace, placement.anchorId, wanted.areaId, wanted.order));
        if (placement.variant !== wanted.variant) patches.push(variantPatch(workspace, placement.anchorId, wanted.variant));
        if (placement.pinned !== wanted.pinned) patches.push(pinPatch(workspace, placement.anchorId, wanted.pinned));
        if (placement.visible !== wanted.visible) patches.push(visibilityPatch(workspace, placement.anchorId, wanted.visible));
      } else if (placement.visible) {
        patches.push(visibilityPatch(workspace, placement.anchorId, false));
      }
    }
    for (const areaId of new Set(defaults.map(placement => placement.areaId))) {
      const wantedIds = defaults.filter(placement => placement.areaId === areaId && placement.visible).sort((a, b) => a.order - b.order).map(placement => placement.anchorId);
      const currentIds = editingWorkspace.placements.filter(placement => placement.areaId === areaId && placement.visible).sort((a, b) => a.order - b.order).map(placement => placement.anchorId);
      if (wantedIds.join("\n") !== currentIds.join("\n")) patches.push(reorderPatch(workspace, areaId, wantedIds));
    }
    if (patches.length > 0 || constraints.length > 0) void preview({
      patchId: `reset_${crypto.randomUUID()}`,
      patchSchemaVersion: 1,
      scope: workspace.scope,
      baseRevision: workspace.sourceActiveRevision,
      catalogVersion: workspace.catalogVersion,
      author: "user",
      provenance: {},
      intent: { kind: "custom", status: "explicit" },
      operations: patches.flatMap(patch => patch.operations),
      evidence: [],
      proposedConstraints: [],
      revokedConstraintIds: constraints.map(constraint => constraint.id),
    });
  };

  const reorder = (anchorId: string, direction: -1 | 1) => {
    const current = placements.filter(placement => placement.areaId === placements.find(item => item.anchorId === anchorId)?.areaId);
    const index = current.findIndex(placement => placement.anchorId === anchorId);
    const other = current[index + direction];
    if (!other) return;
    const areaId = current[index].areaId;
    const anchorIds = current.map(placement => placement.anchorId);
    [anchorIds[index], anchorIds[index + direction]] = [anchorIds[index + direction], anchorIds[index]];
    lastActionAnchor.current = anchorId;
    void preview(reorderPatch(workspace, areaId, anchorIds));
  };

  const dropAssessment = (anchorId: string, sourceAreaId: string, targetAreaId: string, orderedAnchorIds?: readonly string[]) => {
    const anchor = anchors.get(anchorId);
    const targetArea = areas.find(area => area.id === targetAreaId);
    const placement = placements.find(item => item.anchorId === anchorId);
    if (!anchor || !targetArea || !placement) return { allowed: false, reason: "incompatible" } as const;
    return assessWorkspaceDrop({
      anchor,
      sourceAreaId,
      targetArea,
      visible: placement.visible,
      targetVisibleCount: placements.filter(item => item.areaId === targetAreaId && item.visible).length,
      constraints,
      placements,
      anchorsById: anchors,
      orderedAnchorIds,
    });
  };

  const dropError = (anchorId: string, sourceAreaId: string, targetAreaId: string, orderedAnchorIds?: readonly string[]) => {
    const assessment = dropAssessment(anchorId, sourceAreaId, targetAreaId, orderedAnchorIds);
    const targetArea = areas.find(area => area.id === targetAreaId);
    const reason = assessment.allowed ? "incompatible" : assessment.reason;
    const alternatives = areas.filter(area => area.id !== targetAreaId && dropAssessment(anchorId, sourceAreaId, area.id).allowed).map(area => areaLabel(area.id));
    const detail = t(`settings.categories.workspace.dropReasons.${reason}`, { area: areaLabel(targetAreaId), used: placements.filter(item => item.areaId === targetAreaId && item.visible).length, capacity: targetArea?.capacity ?? 0 });
    return `${detail} ${alternatives.length > 0 ? t("settings.categories.workspace.dropAlternatives", { areas: alternatives.join(", ") }) : t("settings.categories.workspace.dropUseMenu")}`;
  };

  const drop = (targetAreaId: string, targetAnchorId?: string) => {
    if (!dragged) return;
    const { anchorId, areaId: sourceAreaId } = dragged;
    const finish = () => { setDragged(null); setDropTarget(null); };
    if (sourceAreaId === targetAreaId && targetAnchorId === anchorId) {
      finish();
      return;
    }
    const currentIds = placements.filter(item => item.areaId === targetAreaId && item.visible).sort((a, b) => a.order - b.order).map(item => item.anchorId);
    let orderedAnchorIds: string[] | undefined;
    if (sourceAreaId === targetAreaId) {
      orderedAnchorIds = currentIds.filter(id => id !== anchorId);
      const targetIndex = targetAnchorId ? orderedAnchorIds.indexOf(targetAnchorId) : orderedAnchorIds.length;
      if (targetIndex < 0) {
        finish();
        setError(dropError(anchorId, sourceAreaId, targetAreaId));
        return;
      }
      orderedAnchorIds.splice(targetIndex, 0, anchorId);
    }
    const assessment = dropAssessment(anchorId, sourceAreaId, targetAreaId, orderedAnchorIds);
    finish();
    if (!assessment.allowed) {
      setError(dropError(anchorId, sourceAreaId, targetAreaId, orderedAnchorIds));
      return;
    }
    setError(null);
    lastActionAnchor.current = anchorId;
    if (assessment.operation === "reorder" && orderedAnchorIds) {
      if (orderedAnchorIds.join("\n") !== currentIds.join("\n")) void preview(reorderPatch(workspace, targetAreaId, orderedAnchorIds));
      return;
    }
    const targetOrder = targetAnchorId ? placements.find(item => item.anchorId === targetAnchorId)?.order ?? currentIds.length : currentIds.length;
    void preview(movePatch(workspace, anchorId, targetAreaId, targetOrder));
  };

  const endDrag = () => {
    if (dragged && dropTarget && !dropAssessment(dragged.anchorId, dragged.areaId, dropTarget).allowed) setError(dropError(dragged.anchorId, dragged.areaId, dropTarget));
    setDragged(null);
    setDropTarget(null);
  };

  const markDiscovery = async (id: string, placed: boolean, kind: "anchor" | "area" = "anchor") => {
    setBusy(true);
    setError(null);
    try {
      await actions.markDiscovery({
        seenAnchorIds: kind === "anchor" ? workspace.discoveryAnchorIds : [],
        placedAnchorIds: kind === "anchor" && placed ? [id] : [],
        dismissedAnchorIds: kind === "anchor" && !placed ? [id] : [],
        seenAreaIds: kind === "area" ? workspace.discoveryAreaIds : [],
        placedAreaIds: kind === "area" && placed ? [id] : [],
        dismissedAreaIds: kind === "area" && !placed ? [id] : [],
      });
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (targetRevision: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await actions.rollback(targetRevision);
      restoreFocus.current = null;
      latestDraft.current = result.draft;
      setPending({ draft: result.draft, descriptor: result.candidate.descriptor.effectiveRevision, workspace: result.candidate.workspace });
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {visibleError && <p role="alert" className="mb-4 rounded-md bg-danger-soft px-3 py-2 text-body-sm text-danger">{visibleError}</p>}
      {busy && <p role="status" className="mb-4 text-body-sm text-muted-foreground">{t(applying ? "settings.categories.workspace.applying" : "settings.categories.workspace.saving")}</p>}
      {presentationStatus !== "stable" && <div className="mb-4 flex flex-wrap items-center gap-3">
        <p role="status" className="text-body-sm text-muted-foreground">{t(`settings.categories.workspace.states.${presentationStatus}`)}</p>
        {pendingActivation && <Button size="sm" variant="outline" disabled={busy} onClick={() => void recover()}>{t("settings.categories.workspace.recover")}</Button>}
      </div>}
      <SettingsGroup id="workspace-layout" title={t("settings.categories.workspace.layoutTitle")} description={t("settings.categories.workspace.layoutDescription")}>
        <p className="text-caption text-muted-foreground">{t("settings.categories.workspace.dragHint")}</p>
        <div className="grid gap-4">
          {areas.map(targetArea => {
            const areaPlacements = placements.filter(placement => placement.areaId === targetArea.id);
            const visibleCount = areaPlacements.filter(placement => placement.visible).length;
            const assessment = dragged ? dropAssessment(dragged.anchorId, dragged.areaId, targetArea.id) : null;
            const areaLabelId = `workspace-area-${targetArea.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
            return (
              <section
                key={targetArea.id}
                aria-labelledby={areaLabelId}
                data-drop-area={targetArea.id}
                data-drop-state={dropTarget === targetArea.id && assessment ? assessment.allowed ? "allowed" : "invalid" : undefined}
                className={`rounded-md border p-3 ${dropTarget === targetArea.id ? assessment?.allowed ? "border-primary" : "border-destructive" : "border-transparent"}`}
                onDragOver={event => {
                  if (!dragged) return;
                  setDropTarget(targetArea.id);
                  if (dropAssessment(dragged.anchorId, dragged.areaId, targetArea.id).allowed) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }
                }}
                onDragLeave={event => {
                  if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null);
                }}
                onDrop={event => {
                  event.preventDefault();
                  const targetAnchorId = event.target instanceof Element ? event.target.closest("[data-anchor]")?.getAttribute("data-anchor") ?? undefined : undefined;
                  drop(targetArea.id, targetAnchorId);
                }}
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 id={areaLabelId} className="text-body-sm font-medium">{areaLabel(targetArea.id)}</h3>
                  <p className="text-caption text-muted-foreground">{t("settings.categories.workspace.areaCapacity", { used: visibleCount, capacity: targetArea.capacity })}</p>
                </div>
                {dropTarget === targetArea.id && dragged && assessment && <p role="status" className="mb-3 text-caption text-muted-foreground">{assessment.allowed ? t("settings.categories.workspace.dropAllowed") : t(`settings.categories.workspace.dropReasons.${assessment.reason}`, { area: areaLabel(targetArea.id), used: visibleCount, capacity: targetArea.capacity })}</p>}
                <div className="grid gap-3">
                  {areaPlacements.map(placement => {
                    const anchor = anchors.get(placement.anchorId);
                    const canMove = anchor?.studio.operations.includes("move") ?? false;
                    const canReorder = (direction: -1 | 1) => {
                      if (!anchor?.studio.operations.includes("reorder")) return false;
                      const index = placements.findIndex(item => item.anchorId === placement.anchorId);
                      const other = placements[index + direction];
                      const target = other?.areaId === placement.areaId && other ? anchors.get(other.anchorId) : undefined;
                      return Boolean(target && !target.critical && target.statePolicy !== "dirty" && target.studio.operations.includes("reorder"));
                    };
                    const label = anchor ? t(anchor.accessibility.labelKey as MessageKey) : placement.anchorId;
                    const labelId = `workspace-anchor-${placement.anchorId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
                    return (
                      <div
                        key={placement.anchorId}
                        role="group"
                        aria-labelledby={labelId}
                        className="grid gap-2 border-b pb-3 last:border-b-0 last:pb-0"
                        data-anchor={placement.anchorId}
                        draggable={!busy && (canMove || anchor?.studio.operations.includes("reorder"))}
                        onDragStart={event => {
                          event.dataTransfer.setData("text/plain", placement.anchorId);
                          event.dataTransfer.effectAllowed = "move";
                          setDragged({ anchorId: placement.anchorId, areaId: placement.areaId });
                          setError(null);
                        }}
                        onDragEnd={endDrag}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p id={labelId} className="font-medium">{label}</p>
                            <p className="text-caption text-muted-foreground">{areaLabel(targetArea.id)} · {t(`settings.categories.workspace.variants.${placement.variant}`)}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button variant="ghost" size="icon-sm" disabled={!canReorder(-1) || busy} aria-label={`${t("settings.categories.workspace.up")}: ${label}`} onClick={() => reorder(placement.anchorId, -1)}>
                              <ArrowUp className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon-sm" disabled={!canReorder(1) || busy} aria-label={`${t("settings.categories.workspace.down")}: ${label}`} onClick={() => reorder(placement.anchorId, 1)}>
                              <ArrowDown className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <label className="flex min-h-11 items-center gap-2 text-body-sm sm:min-h-6">
                            <Checkbox className="size-target" disabled={busy || !anchor?.studio.operations.includes("hide")} checked={placement.visible} onCheckedChange={() => void preview(visibilityPatch(workspace, placement.anchorId, !placement.visible))} />
                            {placement.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                            {placement.visible ? t("settings.categories.workspace.visible") : t("settings.categories.workspace.hidden")}
                          </label>
                          <label className="flex min-h-11 items-center gap-2 text-body-sm sm:min-h-6">
                            <Pin className="h-4 w-4" />
                            <Checkbox className="size-target" disabled={busy || !anchor?.studio.operations.includes("pin")} checked={placement.pinned} onCheckedChange={() => void preview(pinPatch(workspace, placement.anchorId, !placement.pinned))} />
                            {t("settings.categories.workspace.pinned")}
                          </label>
                          <Select value={placement.variant} onValueChange={value => void preview(variantPatch(workspace, placement.anchorId, value as typeof placement.variant))}>
                            <SelectTrigger disabled={busy} aria-label={t("settings.categories.workspace.variant")} className="w-full sm:w-32"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {anchor?.studio.variants.map(variant => <SelectItem key={variant} value={variant}>{t(`settings.categories.workspace.variants.${variant}`)}</SelectItem>)}
                            </SelectContent>
                          </Select>
                          {canMove && (
                            <Select value={placement.areaId} onValueChange={value => void preview(movePatch(workspace, placement.anchorId, value))}>
                              <SelectTrigger disabled={busy} aria-label={t("settings.categories.workspace.area")} className="w-full sm:w-44"><SelectValue>{areaLabel(placement.areaId)}</SelectValue></SelectTrigger>
                              <SelectContent>
                                {areas.filter(area => area.id !== placement.areaId && area.allowedAnchorIds.includes(placement.anchorId)).map(area => <SelectItem key={area.id} value={area.id}>{areaLabel(area.id)}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button id="workspace-reset" variant="outline" size="sm" disabled={busy || placements.length === 0} onClick={reset}>
            <RotateCcw className="h-4 w-4" /> {t("settings.categories.workspace.reset")}
          </Button>
          {pending && <Button size="sm" disabled={busy} onClick={apply}>{t("settings.categories.workspace.apply")}</Button>}
          {pending && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void discard()}>{t("settings.categories.workspace.discard")}</Button>}
        </div>
        {pending && <p className="mt-2 text-caption text-muted-foreground">{t("settings.categories.workspace.preview")}</p>}
      </SettingsGroup>

      <SettingsGroup id="workspace-history" title={t("settings.categories.workspace.historyTitle")} description={t("settings.categories.workspace.historyDescription")}>
        {revisions.length === 0 ? <p className="text-body-sm text-muted-foreground">{t("settings.categories.workspace.noHistory")}</p> : (
          <ul className="grid gap-1">
            {[{ revisionId: "default", committedAt: 0, changes: 0 }, ...revisions].map((revision, index, all) => {
              const current = index === all.length - 1;
              const name = revision.revisionId === "default"
                ? t("settings.categories.workspace.historyDefault")
                : t("settings.categories.workspace.historyEntry", { when: savedAt().format(revision.committedAt), count: revision.changes });
              return (
                <li key={revision.revisionId}>
                  <ActionRow
                    actions={current
                      ? <Chip tone="neutral">{t("settings.categories.workspace.historyCurrent")}</Chip>
                      : <Button variant="ghost" size="sm" disabled={busy} aria-label={`${t("settings.categories.workspace.rollback")}: ${name}`} onClick={() => void rollback(revision.revisionId)}>{t("settings.categories.workspace.rollback")}</Button>}
                  >
                    <span className="min-w-0 truncate tabular-nums">{name}</span>
                  </ActionRow>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsGroup>

      {(workspace.discoveryAnchorIds.length > 0 || workspace.discoveryAreaIds.length > 0) && (
        <SettingsGroup id="workspace-discovery" title={t("settings.categories.workspace.discoveryTitle")} description={t("settings.categories.workspace.discoveryDescription")}>
          <ul className="grid gap-2">
            {workspace.discoveryAreaIds.map(areaId => <li key={areaId} data-discovery-area={areaId} className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <span className="min-w-0">{areaLabel(areaId)}</span>
              <span className="flex flex-wrap items-center gap-2">
                <Chip tone="info">{t("settings.categories.workspace.new")}</Chip>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void markDiscovery(areaId, true, "area")}>{t("settings.categories.workspace.place")}</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void markDiscovery(areaId, false, "area")}>{t("settings.categories.workspace.dismiss")}</Button>
              </span>
            </li>)}
            {workspace.discoveryAnchorIds.map(anchorId => <li key={anchorId} data-discovery-anchor={anchorId} className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <span className="min-w-0">{anchors.get(anchorId) ? t(anchors.get(anchorId)!.accessibility.labelKey as MessageKey) : anchorId}</span>
              <span className="flex flex-wrap items-center gap-2">
                <Chip tone="info">{t("settings.categories.workspace.new")}</Chip>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void markDiscovery(anchorId, true)}>{t("settings.categories.workspace.place")}</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void markDiscovery(anchorId, false)}>{t("settings.categories.workspace.dismiss")}</Button>
              </span>
            </li>)}
          </ul>
        </SettingsGroup>
      )}
      <Suspense fallback={null}><FlowMapPanel onPatch={preview} /></Suspense>
      <Suspense fallback={null}><PlannerPanel draft={pending?.draft ?? null} onPatch={preview} onRestore={(draft, descriptor, previewWorkspace) => { latestDraft.current = draft; setPending({ draft, descriptor, workspace: previewWorkspace }); }} /></Suspense>
    </>
  );
}
