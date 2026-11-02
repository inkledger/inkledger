import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { ActionRow } from "@/components/app/ActionRow";
import { Chip } from "@/components/app/Chip";
import { Button } from "@/components/ui/button";
import { WorkspaceScopeProvider } from "@/lib/workspace/provider";
import { useWorkspace } from "@/lib/workspace/context";
import { staleDraftOf, useWorkspaceActions } from "@/lib/workspace/actions";
import { draftFromWorkspace, movePatch, pinPatch, reorderPatch, variantPatch, visibilityPatch } from "@/lib/workspace/draft";
import { assessWorkspaceDrop } from "@/lib/workspace/drag";
import { areaLabel, anchorLabel, inPageOrder, periodLabel } from "@/lib/workspace/labels";
import { applyLocally, blocksIn, heatLayerOf, sketchFor, type LocalChange } from "@/lib/workspace/sketch";
import { trpc } from "@/lib/trpc";
import { CATALOG_V1, PRODUCT_DEFAULTS_V1 } from "@contracts/workspace/catalogV1";
import { productDefaultFor } from "@contracts/workspace/catalog";
import type { Draft, ResolvedPlacement, ResolvedWorkspace, Scope, SuggestionPatch, Variant } from "@contracts/workspace/model";
import type { ReproposalDrop } from "@contracts/workspace/repropose";
import { failureText } from "@/lib/errorText";
import { useProviderName } from "@/hooks/useConnections";
import { dateFormat, t } from "@/i18n";
import { LayoutCanvas, type BlockRules, type CanvasActions } from "./LayoutCanvas";
import { HeatLegend } from "./HeatOverlay";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { prefersReducedMotion } from "@/lib/dom";
import { placementsFor } from "@/lib/workspace/utils";
import { randomUUID } from "@/lib/randomId";

const FlowMapPanel = lazy(() => import("./FlowMapPanel"));
const PlannerPanel = lazy(() => import("./PlannerPanel"));

/** The pages a layout is made for, each with its own: the Dashboard has one per device class. */
const SCOPES = {
  "dashboard:desktop": { surfaceId: "dashboard", deviceClass: "desktop" },
  "dashboard:mobile": { surfaceId: "dashboard", deviceClass: "mobile" },
  "shell-desktop:desktop": { surfaceId: "shell-desktop", deviceClass: "desktop" },
  "mobile-tabs:mobile": { surfaceId: "mobile-tabs", deviceClass: "mobile" },
} as const satisfies Record<string, Scope>;
type ScopeKey = keyof typeof SCOPES;
// Labels read when drawn, never at import: they follow the language the page is in.
const scopeOptions = (): { value: ScopeKey; label: string }[] => [
  { value: "dashboard:desktop", label: t("settings.categories.workspace.dashboardDesktop") },
  { value: "dashboard:mobile", label: t("settings.categories.workspace.dashboardPhone") },
  { value: "shell-desktop:desktop", label: t("settings.categories.workspace.shell") },
  { value: "mobile-tabs:mobile", label: t("settings.categories.workspace.mobile") },
];

type Pending = { draft: Draft; workspace: ResolvedWorkspace | null };

const savedAt = () => dateFormat({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function WorkspaceSection() {
  const [scopeKey, setScopeKey] = useState<ScopeKey>("dashboard:desktop");
  return (
    <div className="contents">
      <SettingsGroup id="workspace-scope" title={t("settings.categories.workspace.scope")} description={t("settings.categories.workspace.scopeHint")}>
        <SegmentedControl label={t("settings.categories.workspace.scope")} value={scopeKey} onChange={setScopeKey} options={scopeOptions()} />
      </SettingsGroup>
      <WorkspaceScopeProvider key={scopeKey} scope={SCOPES[scopeKey]} live>
        <WorkspaceEditor />
      </WorkspaceScopeProvider>
    </div>
  );
}

function WorkspaceEditor() {
  const provider = useProviderName();
  const { scope, clientInstanceId, workspace, descriptor, revisions, draft: restoredDraft, draftDescriptor, draftWorkspace, presentationStatus, pendingActivation, constraints } = useWorkspace();
  const actions = useWorkspaceActions(scope, clientInstanceId);
  const [localPending, setLocalPending] = useState<Pending | null>(null);
  const [completedDraftId, setCompletedDraftId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "Applying" only while a layout is being applied; a preview being saved says so instead.
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A draft refused for being made on an older layout (another tab applied since): what of it can be kept.
  const [stale, setStale] = useState<{ draft: Draft; keepable: number } | null>(null);
  // The changes of such a draft left out when the rest was proposed again, and why.
  const [notKept, setNotKept] = useState<readonly ReproposalDrop[]>([]);
  // The change drawn at once, before the server's preview of it comes back (or refuses it).
  const [optimistic, setOptimistic] = useState<ResolvedPlacement[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [showApplied, setShowApplied] = useState(false);
  const [showUse, setShowUse] = useState(false);
  // The periods of use (FlowMap) the canvas can lay over its blocks: this week so far first, then the
  // saved ones newest first; only this device's own, only with some use.
  const flow = trpc.flowMap.get.useQuery({ scope: workspace.scope });
  const [usePeriod, setUsePeriod] = useState<string | null>(null);
  const usePeriods = useMemo(() => {
    const used = (item: { heat: readonly { activations: number }[] }) => item.heat.some(point => point.activations > 0);
    const live = flow.data?.live && used(flow.data.live) ? [flow.data.live] : [];
    const stored = (flow.data?.evidence ?? []).filter(item => item.origin === "local" && item.coverage.lastAt > 0 && used(item)).sort((a, b) => b.coverage.lastAt - a.coverage.lastAt);
    return [...live, ...stored];
  }, [flow.data]);
  const shownPeriod = usePeriods.find(item => item.evidenceId === usePeriod) ?? usePeriods[0] ?? null;
  const usage = useMemo(() => shownPeriod ? heatLayerOf(shownPeriod.heat) : null, [shownPeriod]);
  const periodName = (item: { evidenceId: string; coverage: Parameters<typeof periodLabel>[0] }) => item.evidenceId === flow.data?.live?.evidenceId ? t("settings.categories.workspace.timelineLive") : periodLabel(item.coverage);
  const lastActionAnchor = useRef<string | undefined>(undefined);
  const restoreFocus = useRef<string | null | undefined>(undefined);
  const previewQueue = useRef<Promise<void>>(Promise.resolve());
  const latestDraft = useRef<Draft | null>(null);
  const queuedPreviews = useRef(0);
  const anchors = useMemo(() => new Map(CATALOG_V1.anchors.map(anchor => [anchor.id, anchor] as const)), []);
  const areas = useMemo(() => inPageOrder(CATALOG_V1.areas.filter(area => area.surfaceId === workspace.scope.surfaceId)), [workspace.scope.surfaceId]);
  const restoredPending = restoredDraft && restoredDraft.draftId !== completedDraftId ? { draft: restoredDraft, workspace: draftWorkspace } : null;
  const pending = restoredPending && (!localPending || restoredPending.draft.draftRevision > localPending.draft.draftRevision) ? restoredPending : localPending;
  const editingWorkspace = pending?.workspace ?? workspace;
  const placements = useMemo(() => [...editingWorkspace.placements].sort((a, b) => (a.areaId < b.areaId ? -1 : a.areaId > b.areaId ? 1 : 0) || a.order - b.order || (a.anchorId < b.anchorId ? -1 : 1)), [editingWorkspace]);
  const shownPlacements = showApplied && pending ? workspace.placements : optimistic ?? placements;
  const sketch = sketchFor(workspace.scope);
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

  const preview = (patch: Parameters<typeof draftFromWorkspace>[1][number], local?: LocalChange): Promise<void> => {
    if (local) {
      setShowApplied(false);
      setOptimistic(current => applyLocally(current ?? placements, local));
    }
    const operation = patch.operations[0];
    if (operation?.type !== "reorder") lastActionAnchor.current = patch.operations.length === 1 ? operation?.anchorId : undefined;
    const displayed = pending?.draft ?? restoredDraft;
    const previous = latestDraft.current && (!displayed || latestDraft.current.draftRevision >= displayed.draftRevision) ? latestDraft.current : displayed;
    const draft = draftFromWorkspace(workspace, [patch], previous);
    latestDraft.current = draft;
    queuedPreviews.current++;
    setBusy(true);
    setError(null);
    setStale(null);
    setNotKept([]);
    const save = async () => {
      try {
        const result = await actions.saveDraft(draft);
        if (latestDraft.current === draft) {
          latestDraft.current = result.draft;
          setPending({ draft: result.draft, workspace: result.preview.workspace });
        }
      } catch (e) {
        if (latestDraft.current === draft) refused(e, draft);
      } finally {
        queuedPreviews.current--;
        // Once every queued change has its answer, the server's preview is what is drawn.
        if (queuedPreviews.current === 0) {
          setBusy(false);
          setOptimistic(null);
        }
      }
    };
    previewQueue.current = previewQueue.current.then(save);
    return previewQueue.current;
  };

  /** A save refused: its words, and for a draft made on an older layout, what of it could be kept. */
  const refused = (e: unknown, draft: Draft) => {
    setError(failureText(e));
    const info = staleDraftOf(e);
    setStale(info ? { draft, keepable: info.keepable } : null);
  };

  // The stale draft's other changes, proposed again on the current layout: a preview, applied only by Apply.
  const keepOthers = async () => {
    if (!stale) return;
    setBusy(true);
    setError(null);
    try {
      const result = await actions.reproposeDraft(stale.draft);
      setStale(null);
      setNotKept(result.dropped);
      if (result.draft && result.preview) {
        restoreFocus.current = null;
        latestDraft.current = result.draft;
        setPending({ draft: result.draft, workspace: result.preview.workspace });
      }
    } catch (e) {
      setStale(null);
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!pending) return;
    setBusy(true);
    setApplying(true);
    setError(null);
    setStale(null);
    // Apply is disabled while it runs: whatever the outcome, the keyboard comes back to the layout.
    restoreFocus.current = lastActionAnchor.current ?? null;
    try {
      const result = await actions.applyDraft(pending.draft);
      if (result.status === "applied") {
        latestDraft.current = null;
        setCompletedDraftId(pending.draft.draftId);
        setPending(null);
        setNotKept([]);
      } else if (result.status === "conflict") setError(t("settings.categories.workspace.conflict"));
      else if (result.status === "deferred") setError(t("settings.categories.workspace.deferred"));
    } catch (e) {
      refused(e, pending.draft);
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
      setNotKept([]);
      setCompletedDraftId(pending.draft.draftId);
      setPending(null);
      // Focused once the page is no longer busy (Reset is disabled until then).
      restoreFocus.current = null;
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
      const currentIds = placementsFor(editingWorkspace, areaId).map(placement => placement.anchorId);
      if (wantedIds.join("\n") !== currentIds.join("\n")) patches.push(reorderPatch(workspace, areaId, wantedIds));
    }
    if (patches.length > 0 || constraints.length > 0) void preview({
      patchId: `reset_${randomUUID()}`,
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

  /**
   * A block put at `index` among the target area's other blocks, as drawn (hidden ones included): within
   * its area a reorder of the visible ones, into another area a move to the block it lands before.
   */
  const target = (anchorId: string, areaId: string, index: number) => {
    const placement = placements.find(item => item.anchorId === anchorId);
    if (!placement) return null;
    const rest = blocksIn(placements, areaId).filter(item => item.anchorId !== anchorId);
    const at = Math.max(0, Math.min(index, rest.length));
    if (placement.areaId === areaId) {
      const visible = rest.filter(item => item.visible).map(item => item.anchorId);
      const before = rest.slice(0, at).filter(item => item.visible).length;
      const ordered = [...visible.slice(0, before), anchorId, ...visible.slice(before)];
      const current = blocksIn(placements, areaId).filter(item => item.visible).map(item => item.anchorId);
      return { kind: "reorder" as const, ordered, unchanged: ordered.join("\n") === current.join("\n"), index: at, source: placement.areaId };
    }
    return { kind: "move" as const, order: rest[at]?.order ?? (rest.length > 0 ? Math.max(...rest.map(item => item.order)) + 1 : 0), index: at, source: placement.areaId };
  };

  const check: CanvasActions["check"] = (anchorId, areaId, index) => {
    const where = target(anchorId, areaId, index);
    if (!where) return { allowed: false, reason: dropError(anchorId, areaId, areaId) };
    if (where.kind === "reorder" && where.unchanged) return { allowed: true };
    const ordered = where.kind === "reorder" ? where.ordered : undefined;
    return dropAssessment(anchorId, where.source, areaId, ordered).allowed ? { allowed: true } : { allowed: false, reason: dropError(anchorId, where.source, areaId, ordered) };
  };

  const place = (anchorId: string, areaId: string, index: number) => {
    const where = target(anchorId, areaId, index);
    if (!where || (where.kind === "reorder" && where.unchanged)) return;
    const verdict = check(anchorId, areaId, index);
    if (!verdict.allowed) {
      setError(verdict.reason);
      return;
    }
    setError(null);
    lastActionAnchor.current = anchorId;
    const local: LocalChange = { kind: "place", anchorId, areaId, index: where.index };
    void preview(where.kind === "reorder" ? reorderPatch(workspace, areaId, where.ordered) : movePatch(workspace, anchorId, areaId, where.order), local);
  };

  // FlowMap is off: take the user to its switch (with its explanation), never turn it on from here.
  const showFlowMap = () => {
    const section = document.getElementById("workspace-flowmap");
    section?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    section?.querySelector<HTMLElement>("[role='checkbox']")?.focus({ preventScroll: true });
  };

  const canvasActions: CanvasActions = {
    visible: (anchorId, visible) => void preview(visibilityPatch(workspace, anchorId, visible), { kind: "visible", anchorId, visible }),
    pinned: (anchorId, pinned) => void preview(pinPatch(workspace, anchorId, pinned), { kind: "pinned", anchorId, pinned }),
    variant: (anchorId, variant: Variant) => void preview(variantPatch(workspace, anchorId, variant), { kind: "variant", anchorId, variant }),
    place,
    check,
  };

  /** What each block may do here, and in words why one cannot move (said on the block, not learnt by failing). */
  const rules = (anchorId: string): BlockRules => {
    const anchor = anchors.get(anchorId);
    const operations = anchor?.studio.operations ?? [];
    const pinnedByRule = constraints.some(constraint => constraint.status === "explicit" && constraint.anchorId === anchorId && constraint.kind === "pin");
    const locked = !anchor ? null
      : anchor.critical || anchor.statePolicy === "critical" ? t("settings.categories.workspace.lockedCritical", { block: anchorLabel(anchorId) })
        : anchor.statePolicy === "dirty" ? t("settings.categories.workspace.lockedDialog", { block: anchorLabel(anchorId) })
          : pinnedByRule ? t("settings.categories.workspace.lockedPinned", { block: anchorLabel(anchorId) })
            : null;
    return {
      canMove: !locked && operations.includes("move"),
      canReorder: !locked && operations.includes("reorder"),
      canHide: operations.includes("hide"),
      canPin: operations.includes("pin"),
      variants: anchor?.studio.variants ?? [],
      locked,
    };
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
      setPending({ draft: result.draft, workspace: result.candidate.workspace });
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {visibleError && <div role="alert" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-danger-soft px-3 py-2 text-body-sm text-danger">
        <p className="min-w-0 [overflow-wrap:anywhere]">{visibleError}</p>
        {error && stale && stale.keepable > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => void keepOthers()}>{t("settings.categories.workspace.keepOthers", { count: stale.keepable })}</Button>}
      </div>}
      {busy && <p role="status" className="mb-4 text-body-sm text-muted-foreground">{t(applying ? "settings.categories.workspace.applying" : "settings.categories.workspace.saving")}</p>}
      {presentationStatus !== "stable" && <div className="mb-4 flex flex-wrap items-center gap-3">
        <p role="status" className="text-body-sm text-muted-foreground">{t(`settings.categories.workspace.states.${presentationStatus}`)}</p>
        {pendingActivation && <Button size="sm" variant="outline" disabled={busy} onClick={() => void recover()}>{t("settings.categories.workspace.recover")}</Button>}
      </div>}
      <SettingsGroup id="workspace-layout" title={t("settings.categories.workspace.layoutTitle")} description={t("settings.categories.workspace.layoutDescription")}>
        <p id="workspace-canvas-hint" className="text-caption text-muted-foreground">{t("settings.categories.workspace.canvasHint")}</p>
        {flow.data && !flow.data.settings.enabled && (
          <ActionRow actions={<Button variant="outline" size="sm" onClick={showFlowMap}>{t("settings.categories.workspace.useOff")}</Button>}>
            <span className="text-caption text-muted-foreground">{t("settings.categories.workspace.useOffHint")}</span>
          </ActionRow>
        )}
        {flow.data?.settings.enabled && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            {showUse && usage ? (
              <span className="grid min-w-0 gap-1">
                <HeatLegend />
                {shownPeriod && shownPeriod.descriptor.effectiveRevision !== descriptor.effectiveRevision && <span className="text-caption text-muted-foreground">{t("settings.categories.workspace.useOtherLayout")}</span>}
              </span>
            ) : (
              <span className="min-w-0 flex-1 text-caption text-muted-foreground">{usage ? t("settings.categories.workspace.showUseHint") : t("settings.categories.workspace.useNone")}</span>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {showUse && usePeriods.length > 1 && shownPeriod && (
                <Select value={shownPeriod.evidenceId} onValueChange={setUsePeriod}>
                  <SelectTrigger size="sm" aria-label={t("settings.categories.workspace.usePeriod")} className="w-auto min-w-40"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {usePeriods.map(item => <SelectItem key={item.evidenceId} value={item.evidenceId}>{periodName(item)}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              <Button variant="outline" size="sm" aria-pressed={showUse && usage !== null} disabled={!usage} onClick={() => setShowUse(value => !value)}>{t("settings.categories.workspace.showUse")}</Button>
            </div>
          </div>
        )}
        {pending && (
          <SegmentedControl
            label={t("settings.categories.workspace.compare")}
            value={showApplied ? "applied" : "preview"}
            onChange={value => setShowApplied(value === "applied")}
            options={[
              { value: "preview", label: t("settings.categories.workspace.comparePreview") },
              { value: "applied", label: t("settings.categories.workspace.compareApplied") },
            ]}
          />
        )}
        {sketch && (
          <div inert={showApplied && pending ? true : undefined}>
            <LayoutCanvas
              sketch={sketch}
              placements={shownPlacements}
              applied={workspace.placements}
              areas={areas}
              anchors={anchors}
              rules={rules}
              busy={busy || applying}
              actions={canvasActions}
              label={anchorId => anchorLabel(anchorId, { provider })}
              usage={showUse ? usage : null}
              onAnnounce={setAnnouncement}
            />
          </div>
        )}
        <p aria-live="polite" className="sr-only">{announcement}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button id="workspace-reset" variant="outline" size="sm" disabled={busy || placements.length === 0} onClick={reset}>
            <RotateCcw className="h-4 w-4" /> {t("settings.categories.workspace.reset")}
          </Button>
          {pending && <Button size="sm" disabled={busy} onClick={apply}>{t("settings.categories.workspace.apply")}</Button>}
          {pending && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void discard()}>{t("settings.categories.workspace.discard")}</Button>}
        </div>
        {pending && <p className="mt-2 text-caption text-muted-foreground">{t("settings.categories.workspace.preview")}</p>}
        {(["overlap", "refused"] as const).map(reason => {
          const names = [...new Set(notKept.filter(drop => drop.reason === reason).map(drop => drop.anchorId ? anchorLabel(drop.anchorId, { provider }) : drop.areaId ? areaLabel(drop.areaId) : null).filter(name => name !== null))];
          return names.length > 0 && <p key={reason} data-not-kept={reason} className="mt-2 text-caption text-muted-foreground [overflow-wrap:anywhere]">
            {t(reason === "overlap" ? "settings.categories.workspace.notKeptOverlap" : "settings.categories.workspace.notKeptRefused", { blocks: names.join(", ") })}
          </p>;
        })}
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
              <span className="min-w-0">{anchorLabel(anchorId, { provider })}</span>
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
      <Suspense fallback={null}><PlannerPanel draft={pending?.draft ?? null} onPatch={preview} onRestore={(draft, _descriptor, previewWorkspace) => { latestDraft.current = draft; setPending({ draft, workspace: previewWorkspace }); }} /></Suspense>
    </>
  );
}
