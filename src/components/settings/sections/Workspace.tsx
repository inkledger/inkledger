import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Info, RotateCcw, TriangleAlert } from "lucide-react";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { surface } from "@/components/app/surface";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { WorkspaceScopeProvider } from "@/lib/workspace/provider";
import { useWorkspace } from "@/lib/workspace/context";
import { staleDraftOf, useWorkspaceActions } from "@/lib/workspace/actions";
import { draftFromWorkspace, movePatch, pinPatch, reorderPatch, variantPatch, visibilityPatch } from "@/lib/workspace/draft";
import { assessWorkspaceDrop } from "@/lib/workspace/drag";
import { areaLabel, anchorLabel, controlLabel, inPageOrder, periodLabel } from "@/lib/workspace/labels";
import { applyLocally, blocksIn, heatLayerOf, reorderIndexOf, SKETCHES, sketchFor, type LocalChange } from "@/lib/workspace/sketch";
import { blockUse, formatLayerView, frictionByAnchor, layerStates, parseLayerView, pathsAround, pathsOf, shownLayers, toggleLayer, type BlockFriction, type BlockPath, type Layer } from "@/lib/workspace/layers";
import { deviceSetting } from "@/lib/storage";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { CATALOG_V1, PRODUCT_DEFAULTS_V1 } from "@contracts/workspace/catalogV1";
import { productDefaultFor } from "@contracts/workspace/catalog";
import type { Draft, ResolvedPlacement, ResolvedWorkspace, Scope, SuggestionPatch, Variant } from "@contracts/workspace/model";
import type { EvidenceSet, ExpectationGap, FlowMapDocument } from "@contracts/workspace/flowMap";
import type { ReproposalDrop } from "@contracts/workspace/repropose";
import { failureText } from "@/lib/errorText";
import { useProviderName } from "@/hooks/useConnections";
import { t, type MessageKey } from "@/i18n";
import { LayoutCanvas, type BlockRules, type CanvasActions } from "./LayoutCanvas";
import { HeatLegend } from "./HeatOverlay";
import { LayerToolbar } from "./LayerToolbar";
import { PathsOverlay } from "./PathsOverlay";
import { BlockDetails, PageSummary, type BlockActions, type BlockInfo, type DataState, type Gap, type NewItem, type TableData } from "./BlockDetails";
import { ScopePicker, type ScopeOption } from "./ScopePicker";
import { WorkspaceMore, type ShownPeriod } from "./WorkspaceMore";
import { placementsFor } from "@/lib/workspace/utils";
import { randomUUID } from "@/lib/randomId";

const key = (name: string) => `settings.categories.workspace.${name}` as MessageKey;

/** The pages a layout is made for, each with its own: the Dashboard has one per device class. */
const SCOPES = {
  "dashboard:desktop": { surfaceId: "dashboard", deviceClass: "desktop" },
  "dashboard:mobile": { surfaceId: "dashboard", deviceClass: "mobile" },
  "shell-desktop:desktop": { surfaceId: "shell-desktop", deviceClass: "desktop" },
  "mobile-tabs:mobile": { surfaceId: "mobile-tabs", deviceClass: "mobile" },
} as const satisfies Record<string, Scope>;
type ScopeKey = keyof typeof SCOPES;
// Labels read when drawn, never at import: they follow the language the page is in.
const scopeOptions = (): ScopeOption<ScopeKey>[] => [
  { value: "dashboard:desktop", label: t(key("dashboardDesktop")), frame: SKETCHES["dashboard:desktop"].frame },
  { value: "dashboard:mobile", label: t(key("dashboardPhone")), frame: SKETCHES["dashboard:mobile"].frame },
  { value: "shell-desktop:desktop", label: t(key("shell")), frame: SKETCHES["shell-desktop:desktop"].frame },
  { value: "mobile-tabs:mobile", label: t(key("mobile")), frame: SKETCHES["mobile-tabs:mobile"].frame },
];

/** The layers and periods chosen on this device. */
const layerView = deviceSetting("ikl-workspace-layers", parseLayerView, formatLayerView);
/** How many arrows the Paths layer draws: the busiest ones. */
const PATHS_DRAWN = 6;
const DESKTOP = "(min-width: 1024px)";

type Pending = { draft: Draft; workspace: ResolvedWorkspace | null };
/** A period the data layers can show: this week so far, a stored one, or one imported (kept apart). */
type Period = { id: string; label: string; evidence: EvidenceSet; shown: Exclude<ShownPeriod, null>; imported: boolean };

const isChanged = (placement: ResolvedPlacement, applied: readonly ResolvedPlacement[]) => {
  const before = applied.find(item => item.anchorId === placement.anchorId);
  return !before || before.areaId !== placement.areaId || before.order !== placement.order || before.visible !== placement.visible || before.variant !== placement.variant || before.pinned !== placement.pinned;
};

export function WorkspaceSection() {
  const [scopeKey, setScopeKey] = useState<ScopeKey>("dashboard:desktop");
  return (
    // On desktop a pane: the part of the app on top, the layout scrolling in the middle, the footer always in
    // view under it (never laid over the page, so nothing hides behind it). On a phone, one page that scrolls.
    <div data-settings-pane className="flex flex-col lg:min-h-0 lg:flex-1">
      <div className="shrink-0 border-b px-5 py-3 md:px-6">
        <ScopePicker label={t(key("scope"))} value={scopeKey} options={scopeOptions()} onChange={setScopeKey} />
      </div>
      <WorkspaceScopeProvider key={scopeKey} scope={SCOPES[scopeKey]} live>
        <WorkspaceEditor scopeKey={scopeKey} />
      </WorkspaceScopeProvider>
    </div>
  );
}

function WorkspaceEditor({ scopeKey }: { scopeKey: ScopeKey }) {
  const provider = useProviderName();
  const { scope, clientInstanceId, workspace, descriptor, draft: restoredDraft, draftDescriptor, draftWorkspace, presentationStatus, pendingActivation, constraints } = useWorkspace();
  const actions = useWorkspaceActions(scope, clientInstanceId);
  const utils = trpc.useUtils();
  const feedback = trpc.flowMap.feedback.useMutation();
  const [localPending, setLocalPending] = useState<Pending | null>(null);
  const [completedDraftId, setCompletedDraftId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "Applying" only while a layout is being applied; a preview being saved says so instead.
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What an action elsewhere on the page wants said (an import kept apart, periods updated).
  const [notice, setNotice] = useState<string | null>(null);
  // A draft refused for being made on an older layout (another tab applied since): what of it can be kept.
  const [stale, setStale] = useState<{ draft: Draft; keepable: number } | null>(null);
  // The changes of such a draft left out when the rest was proposed again, and why.
  const [notKept, setNotKept] = useState<readonly ReproposalDrop[]>([]);
  // The change drawn at once, before the server's preview of it comes back (or refuses it).
  const [optimistic, setOptimistic] = useState<ResolvedPlacement[] | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [showApplied, setShowApplied] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const isDesktop = useMediaQuery(DESKTOP, typeof window !== "undefined" && window.matchMedia(DESKTOP).matches);
  const view = layerView.use();
  const detailsTitleId = useId();
  const lastActionAnchor = useRef<string | undefined>(undefined);
  const restoreFocus = useRef<string | null | undefined>(undefined);
  const previewQueue = useRef<Promise<void>>(Promise.resolve());
  const latestDraft = useRef<Draft | null>(null);
  const queuedPreviews = useRef(0);
  const anchors = useMemo(() => new Map(CATALOG_V1.anchors.map(anchor => [anchor.id, anchor] as const)), []);
  const anchorOfControl = useMemo(() => new Map(CATALOG_V1.controls.map(control => [control.id, control.anchorId] as const)), []);
  const areas = useMemo(() => inPageOrder(CATALOG_V1.areas.filter(area => area.surfaceId === workspace.scope.surfaceId)), [workspace.scope.surfaceId]);
  const restoredPending = restoredDraft && restoredDraft.draftId !== completedDraftId ? { draft: restoredDraft, workspace: draftWorkspace } : null;
  const pending = restoredPending && (!localPending || restoredPending.draft.draftRevision > localPending.draft.draftRevision) ? restoredPending : localPending;
  const editingWorkspace = pending?.workspace ?? workspace;
  const placements = useMemo(() => [...editingWorkspace.placements].sort((a, b) => (a.areaId < b.areaId ? -1 : a.areaId > b.areaId ? 1 : 0) || a.order - b.order || (a.anchorId < b.anchorId ? -1 : 1)), [editingWorkspace]);
  const shownPlacements = showApplied && pending ? workspace.placements : optimistic ?? placements;
  const sketch = sketchFor(workspace.scope);
  const setPending = setLocalPending;
  const visibleError = error ?? (restoredDraft && !draftDescriptor ? t(key("conflict")) : null);
  const label = (anchorId: string) => anchorLabel(anchorId, { provider });
  const changes = pending ? editingWorkspace.placements.filter(placement => isChanged(placement, workspace.placements)).length : 0;

  // What the data layers can show: this week so far first, then the saved periods newest first (this
  // device's own, with some use), then the imported ones, kept apart.
  const flow = trpc.flowMap.get.useQuery({ scope: workspace.scope });
  const collecting = flow.data?.settings.enabled ?? false;
  const periods = useMemo((): Period[] => {
    const used = (item: EvidenceSet) => item.heat.some(point => point.activations > 0);
    const own = (flow.data?.evidence ?? []).filter(item => item.origin === "local" && item.coverage.lastAt > 0 && used(item)).sort((a, b) => b.coverage.lastAt - a.coverage.lastAt);
    // This week so far, unless a saved period of the same layout already holds all of it.
    const current = flow.data?.live && used(flow.data.live) ? flow.data.live : null;
    const covered = current && own.some(item => item.descriptor.effectiveRevision === current.descriptor.effectiveRevision && item.coverage.lastAt >= current.coverage.lastAt);
    const live = current && !covered ? [{ id: current.evidenceId, label: t(key("timelineLive")), evidence: current, shown: { kind: "live" as const }, imported: false }] : [];
    const stored = own.map(item => ({ id: item.evidenceId, label: periodLabel(item.coverage), evidence: item, shown: { kind: "stored" as const, evidenceId: item.evidenceId }, imported: false }));
    const imported = (flow.data?.imports ?? [])
      .filter(item => used(item.document.evidence))
      .map(({ importId, document }: { importId: string; document: FlowMapDocument }) => ({ id: `import:${importId}`, label: periodLabel(document.evidence.coverage), evidence: document.evidence, shown: { kind: "imported" as const, importId, document }, imported: true }));
    return [...live, ...stored, ...imported];
  }, [flow.data]);
  const period = periods.find(item => item.id === view.periods[scopeKey]) ?? periods.find(item => !item.imported) ?? null;
  const evidence = collecting || period?.imported ? period?.evidence ?? null : null;
  const usage = useMemo(() => evidence ? heatLayerOf(evidence.heat) : null, [evidence]);
  const onPage = (anchorId: string) => anchors.get(anchorId)?.surfaceId === workspace.scope.surfaceId && shownPlacements.some(placement => placement.anchorId === anchorId);
  const anchorOf = (controlId: string) => anchorOfControl.get(controlId);
  const allPaths = evidence ? pathsOf(evidence.flows, anchorOf, onPage) : [];
  const friction = useMemo((): ReadonlyMap<string, BlockFriction> => evidence ? frictionByAnchor(evidence.friction, controlId => anchorOfControl.get(controlId)) : new Map<string, BlockFriction>(), [evidence, anchorOfControl]);
  const news = workspace.discoveryAnchorIds.length + workspace.discoveryAreaIds.length;
  const loading = flow.isPending;
  const states = layerStates({ collecting: loading || collecting || period?.imported === true, hasUse: loading || (usage?.total ?? 0) > 0, hasPaths: loading || allPaths.length > 0, hasFriction: loading || friction.size > 0, news });
  const on = shownLayers(view.layers, states);
  const dataState: DataState = loading ? "ok" : !collecting && !period?.imported ? "off" : evidence ? "ok" : "none";
  const destination = (path: BlockPath) => path.to ? label(path.to) : controlLabel(path.toControlId);
  const toggle = (layer: Layer) => layerView.set(toggleLayer(layerView.get(), layer));
  const choosePeriod = (id: string) => layerView.set({ ...layerView.get(), periods: { ...layerView.get().periods, [scopeKey]: id } });
  // A block no longer drawn has no details to show.
  const selectedPlacement = selected ? shownPlacements.find(placement => placement.anchorId === selected) ?? null : null;

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
    setNotice(null);
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

  const restore = (draft: Draft, previewWorkspace: ResolvedWorkspace) => {
    latestDraft.current = draft;
    setPending({ draft, workspace: previewWorkspace });
  };

  /** A patch from the details or the page summary: a rule taken off, a looked-for thing used. */
  const userPatch = (operations: SuggestionPatch["operations"], extra: Partial<SuggestionPatch>): SuggestionPatch => ({
    patchId: `patch_${randomUUID()}`,
    patchSchemaVersion: 1,
    scope: workspace.scope,
    baseRevision: workspace.sourceActiveRevision,
    catalogVersion: workspace.catalogVersion,
    author: "user",
    provenance: {},
    intent: { kind: "custom", status: "explicit" },
    operations,
    evidence: [],
    proposedConstraints: [],
    ...extra,
  });

  // A thing looked for, as a change: where it was wanted, if this layout can put it there.
  const expectationTarget = (gap: ExpectationGap) => {
    const control = gap.destinationControlId ? CATALOG_V1.controls.find(item => item.id === gap.destinationControlId) : undefined;
    const anchor = control ? anchors.get(control.anchorId) : undefined;
    if (!anchor || anchor.surfaceId !== workspace.scope.surfaceId) return null;
    const placement = workspace.placements.find(item => item.anchorId === anchor.id);
    const area = CATALOG_V1.areas.find(item => item.id === gap.areaId && item.surfaceId === workspace.scope.surfaceId);
    if (!placement || !area || !area.allowedAnchorIds.includes(anchor.id)) return null;
    if (placement.areaId !== area.id && (anchor.statePolicy === "local" || !anchor.studio.operations.includes("move"))) return null;
    return { anchorId: anchor.id, placement, areaId: area.id };
  };
  // A gap by what it says, destination included: two gaps from one area never read the same.
  const gapLabel = (gap: ExpectationGap) => `${t(key(`patterns.${gap.pattern}`), { area: areaLabel(gap.areaId) })}${gap.destinationControlId ? ` → ${controlLabel(gap.destinationControlId)}` : ""}`;
  // Someone else's map (imported) is there to look at: nothing in it to judge or use.
  const gaps: Gap[] = evidence && !period?.imported ? evidence.expectations.map(gap => ({
    id: gap.id,
    label: gapLabel(gap),
    detail: t(key("expectationDetail"), { count: gap.occurrences, state: t(key(`expectationStates.${gap.state}`)) }),
    state: gap.state,
    usable: expectationTarget(gap) !== null,
  })) : [];
  const judge = async (gap: Gap, status: "confirmed" | "rejected") => {
    setError(null);
    try {
      await feedback.mutateAsync({ scope: workspace.scope, expectationId: gap.id, status });
      await utils.flowMap.get.invalidate({ scope: workspace.scope });
    } catch (e) {
      setError(failureText(e));
    }
  };
  const useGap = (item: Gap) => {
    const gap = evidence?.expectations.find(entry => entry.id === item.id);
    const target = gap ? expectationTarget(gap) : null;
    if (!gap || !target || gap.state !== "confirmed" || !evidence) return;
    void preview(userPatch(
      target.placement.areaId === target.areaId ? [] : [{ type: "move", operationId: `op_${randomUUID()}`, anchorId: target.anchorId, toAreaId: target.areaId }],
      {
        intent: { kind: "expectHere", status: "explicit", anchorId: target.anchorId, areaId: target.areaId },
        evidence: [{ evidenceId: evidence.evidenceId, effectiveRevision: evidence.descriptor.effectiveRevision }],
        proposedConstraints: [{ id: `constraint_${randomUUID()}`, kind: "expectHere", status: "explicit", author: "user", scope: workspace.scope, anchorId: target.anchorId, areaId: target.areaId }],
      },
    ));
  };

  const top = usage ? [...usage.uses].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3).map(([id, count]) => ({ id, name: label(id), count })) : [];
  const newItems: NewItem[] = [
    ...workspace.discoveryAreaIds.map(id => ({ kind: "area" as const, id, name: areaLabel(id) })),
    ...workspace.discoveryAnchorIds.map(id => ({ kind: "anchor" as const, id, name: label(id) })),
  ];
  const table: TableData = {
    use: evidence ? [...new Set(evidence.heat.map(point => point.anchorId))].map(id => ({ id, name: label(id), ...blockUse(evidence.heat, id) })).filter(row => row.clicks > 0).sort((a, b) => b.clicks - a.clicks) : [],
    paths: allPaths.map(path => ({ id: `${path.from}>${path.to ?? path.toControlId}`, from: label(path.from), to: destination(path), count: path.count })),
    friction: [...friction].map(([id, value]) => ({ id, name: label(id), detail: t(key("frictionDetail"), { abandoned: value.abandoned, failures: value.failures, backtracks: value.backtracks }) })),
    gaps,
  };

  const blockInfo = (placement: ResolvedPlacement): BlockInfo => {
    const anchorId = placement.anchorId;
    const blockRules = rules(anchorId);
    const overlay = sketch?.areas.find(area => area.areaId === placement.areaId)?.region === "tray";
    const around = pathsAround(allPaths, anchorId);
    return {
      anchorId,
      name: label(anchorId),
      area: areaLabel(placement.areaId),
      visible: placement.visible,
      pinned: placement.pinned,
      variant: placement.variant,
      overlay,
      canHide: blockRules.canHide,
      canPin: blockRules.canPin,
      variants: blockRules.variants,
      locked: blockRules.locked,
      canUp: blockRules.canReorder && reorderIndexOf(placements, anchorId, "up") !== null,
      canDown: blockRules.canReorder && reorderIndexOf(placements, anchorId, "down") !== null,
      moveTargets: blockRules.canMove ? areas.filter(area => area.id !== placement.areaId && check(anchorId, area.id, Number.MAX_SAFE_INTEGER).allowed).map(area => ({ id: area.id, name: areaLabel(area.id) })) : [],
      rules: constraints.filter(constraint => constraint.anchorId === anchorId && constraint.status === "explicit").map(constraint => ({ id: constraint.id, text: t(key(`ruleText.${constraint.kind}`), { anchor: label(anchorId), area: constraint.areaId ? areaLabel(constraint.areaId) : "" }) })),
      isNew: workspace.discoveryAnchorIds.includes(anchorId),
      use: evidence ? blockUse(evidence.heat, anchorId) : null,
      out: around.out.map(path => ({ id: path.to ?? path.toControlId, name: path.to ? label(path.to) : t(key("pathElsewhere"), { name: controlLabel(path.toControlId) }), count: path.count })),
      in: around.in.map(path => ({ id: path.from, name: label(path.from), count: path.count })),
      friction: friction.get(anchorId) ?? null,
    };
  };
  // The selected block's changes, from the details: the same as on the block and in its menu.
  const blockActions: BlockActions = {
    visible: visible => { if (selectedPlacement) canvasActions.visible(selectedPlacement.anchorId, visible); },
    pinned: pinned => { if (selectedPlacement) canvasActions.pinned(selectedPlacement.anchorId, pinned); },
    variant: (variant: Variant) => { if (selectedPlacement) canvasActions.variant(selectedPlacement.anchorId, variant); },
    reorder: to => {
      const index = selectedPlacement ? reorderIndexOf(placements, selectedPlacement.anchorId, to) : null;
      if (selectedPlacement && index !== null) place(selectedPlacement.anchorId, selectedPlacement.areaId, index);
    },
    moveTo: areaId => { if (selectedPlacement) place(selectedPlacement.anchorId, areaId, Number.MAX_SAFE_INTEGER); },
    removeRule: constraintId => void preview(userPatch([], { revokedConstraintIds: [constraintId] })),
    discovery: placed => { if (selectedPlacement) void markDiscovery(selectedPlacement.anchorId, placed); },
  };
  // Back from the details to the block they were about, so the keyboard stays where it was.
  const closeDetails = () => {
    const anchorId = selected;
    setSelected(null);
    if (anchorId) requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>("[data-layout-canvas] [data-anchor]")].find(element => element.getAttribute("data-anchor") === anchorId)?.querySelector<HTMLElement>("[data-select]")?.focus({ preventScroll: true }));
  };
  const details = selectedPlacement ? (
    <BlockDetails
      block={blockInfo(selectedPlacement)}
      data={dataState}
      period={period?.label ?? null}
      busy={busy || applying}
      actions={blockActions}
      onClose={closeDetails}
      titleId={detailsTitleId}
    />
  ) : (
    <PageSummary
      data={dataState}
      period={period?.label ?? null}
      top={top}
      gaps={gaps}
      news={newItems}
      table={table}
      busy={busy || applying || feedback.isPending}
      onGap={(gap, status) => void judge(gap, status)}
      onUseGap={useGap}
      onDiscovery={(item, placed) => void markDiscovery(item.id, placed, item.kind)}
    />
  );

  const legend = [
    on.has("use") && <HeatLegend key="use" />,
    on.has("paths") && <span key="paths" className="flex items-center gap-1.5"><span aria-hidden className="h-0.5 w-4 rounded-full bg-primary-strong" />{t(key("pathsLegend"))}</span>,
    on.has("friction") && <span key="friction" className="flex items-center gap-1.5"><TriangleAlert aria-hidden className="h-3.5 w-3.5 text-warning" />{t(key("frictionLegend"))}</span>,
    on.has("news") && <span key="news" className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-2 rounded-full bg-info" />{t(key("newsLegend"))}</span>,
  ].filter(Boolean);
  const otherLayout = (on.has("use") || on.has("paths") || on.has("friction")) && evidence && evidence.descriptor.effectiveRevision !== descriptor.effectiveRevision;

  return (
    <>
      <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
      <section id="workspace-layout" aria-label={t(key("layoutTitle"))} className="grid gap-3 px-5 pb-6 pt-4 md:px-6">
        <LayerToolbar
          on={on}
          states={states}
          news={news}
          periods={periods.filter(item => collecting || item.imported).map(item => ({ id: item.id, label: item.label, imported: item.imported }))}
          period={period?.id ?? null}
          onToggle={toggle}
          onPeriod={choosePeriod}
          extra={on.has("edit") && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t(key("howToMove"))}><Info className="h-4 w-4" /></Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 text-body-sm">{t(key("canvasHint"))}</PopoverContent>
            </Popover>
          )}
        />
        {/* The handles' description, read with them; the same words are behind the help button. */}
        <p id="workspace-canvas-hint" className="sr-only">{t(key("canvasHint"))}</p>
        {/* One line under the layers, always there: why the data layers are off, or the key of those on. */}
        <div data-layer-line className="flex min-h-target flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
          {loading ? null : flow.isError ? (
            <>
              <span className="text-danger">{t(key("useFailed"))}</span>
              <Button variant="link" size="sm" className="h-auto min-h-target p-0 text-caption" onClick={() => void flow.refetch()}>{t("common.retry")}</Button>
            </>
          ) : dataState === "off" ? (
            <>
              {/* On a phone the link says it alone: the line never wraps, so nothing under it moves once loaded. */}
              <span className="max-sm:sr-only">{t(key("layersOff"))}</span>
              <Button variant="link" size="sm" className="h-auto min-h-target p-0 text-caption" onClick={() => setCollectionOpen(true)}>{t(key("useOff"))}</Button>
            </>
          ) : dataState === "none" ? <span>{t(key("useNone"))}</span>
            : legend.length > 0 ? (
              <>
                {legend}
                {otherLayout && <span>{t(key("useOtherLayout"))}</span>}
              </>
            ) : <span>{t(key("dataHint"))}</span>}
        </div>

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] lg:gap-6">
          <div className="grid min-w-0 gap-2">
            {sketch && (
              <div className="relative" inert={showApplied && pending ? true : undefined}>
                <LayoutCanvas
                  sketch={sketch}
                  placements={shownPlacements}
                  applied={workspace.placements}
                  areas={areas}
                  anchors={anchors}
                  rules={rules}
                  busy={busy || applying}
                  actions={canvasActions}
                  label={label}
                  usage={on.has("use") ? usage : null}
                  layers={{
                    edit: on.has("edit"),
                    friction: on.has("friction") ? friction : null,
                    news: on.has("news") ? { anchors: new Set(workspace.discoveryAnchorIds), areas: new Set(workspace.discoveryAreaIds) } : null,
                  }}
                  selected={selected}
                  onSelect={anchorId => setSelected(current => current === anchorId && isDesktop ? null : anchorId)}
                  onAnnounce={setAnnouncement}
                />
                {on.has("paths") && <PathsOverlay paths={allPaths.slice(0, PATHS_DRAWN)} destination={destination} version={`${shownPlacements.map(item => `${item.anchorId}:${item.areaId}:${item.order}:${item.visible}:${item.variant}`).join("|")}|${[...on].join(",")}`} />}
              </div>
            )}
          </div>
          {isDesktop ? (
            <aside
              aria-label={t(key("detailsTitle"))}
              className="min-w-0 lg:border-l lg:pl-6"
              onKeyDown={event => {
                if (event.key === "Escape" && selected) {
                  event.stopPropagation();
                  closeDetails();
                }
              }}
            >
              {details}
            </aside>
          ) : (
            <div className="border-t pt-4">
              <PageSummary
                data={dataState}
                period={period?.label ?? null}
                top={top}
                gaps={gaps}
                news={newItems}
                table={table}
                busy={busy || applying || feedback.isPending}
                onGap={(gap, status) => void judge(gap, status)}
                onUseGap={useGap}
                onDiscovery={(item, placed) => void markDiscovery(item.id, placed, item.kind)}
              />
            </div>
          )}
        </div>
        <p aria-live="polite" className="sr-only">{announcement}</p>
      </section>
      </div>

      {!isDesktop && (
        <Sheet open={selectedPlacement !== null} onOpenChange={open => { if (!open) closeDetails(); }}>
          <SheetContent side="bottom" aria-describedby={undefined} className="max-h-[85dvh] overflow-y-auto rounded-t-2xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4">
            {selectedPlacement && (
              <BlockDetails
                block={blockInfo(selectedPlacement)}
                data={dataState}
                period={period?.label ?? null}
                busy={busy || applying}
                actions={blockActions}
                onClose={closeDetails}
                titleId={detailsTitleId}
                closable={false}
                Title={SheetTitleTag}
              />
            )}
          </SheetContent>
        </Sheet>
      )}

      <footer
        data-workspace-footer
        {...surface("ground")}
        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t bg-card px-5 py-2 md:px-6"
      >
        <div className="flex items-center gap-0.5">
          <Button id="workspace-reset" variant="ghost" size="sm" aria-label={t(key("reset"))} disabled={busy || placements.length === 0} onClick={reset}>
            <RotateCcw className="h-4 w-4" /><span className="max-sm:sr-only">{t(key("resetShort"))}</span>
          </Button>
          <WorkspaceMore
            busy={busy || applying}
            shown={period?.shown ?? null}
            collectionOpen={collectionOpen}
            onCollectionOpen={setCollectionOpen}
            draft={pending?.draft ?? null}
            onPatch={preview}
            onRestore={restore}
            onRollback={rollback}
            onError={e => setError(failureText(e))}
            onNotice={setNotice}
          />
        </div>
        {/* One place for every status, at a fixed height: the page above never moves for it. */}
        <div data-status-slot aria-live="polite" className="order-first flex min-h-10 min-w-0 basis-full flex-col justify-center gap-0.5 text-caption">
          {visibleError && (
            <div role="alert" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-danger">
              <span className="min-w-0 [overflow-wrap:anywhere]">{visibleError}</span>
              {error && stale && stale.keepable > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={() => void keepOthers()}>{t(key("keepOthers"), { count: stale.keepable })}</Button>}
            </div>
          )}
          {presentationStatus !== "stable" && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <p role="status" className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{t(key(`states.${presentationStatus}`))}</p>
              {pendingActivation && <Button size="sm" variant="outline" disabled={busy} onClick={() => void recover()}>{t(key("recover"))}</Button>}
            </div>
          )}
          {busy && <p role="status" className="text-muted-foreground">{t(key(applying ? "applying" : "saving"))}</p>}
          {notice && !busy && <p role="status" className="text-muted-foreground [overflow-wrap:anywhere]">{notice}</p>}
          {(["overlap", "refused"] as const).map(reason => {
            const names = [...new Set(notKept.filter(drop => drop.reason === reason).map(drop => drop.anchorId ? label(drop.anchorId) : drop.areaId ? areaLabel(drop.areaId) : null).filter(name => name !== null))];
            return names.length > 0 && <p key={reason} data-not-kept={reason} className="text-muted-foreground [overflow-wrap:anywhere]">
              {t(reason === "overlap" ? key("notKeptOverlap") : key("notKeptRefused"), { blocks: names.join(", ") })}
            </p>;
          })}
          {pending && <p className={cn("font-medium text-foreground", busy && "sr-only")}>{changes > 0 ? t(key("draftState"), { count: changes }) : t(key("preview"))}</p>}
          {!pending && !busy && !notice && !visibleError && presentationStatus === "stable" && notKept.length === 0 && <p className="text-muted-foreground">{t(key("footerIdle"))}</p>}
        </div>
        {pending && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <SegmentedControl
              label={t(key("compare"))}
              value={showApplied ? "applied" : "preview"}
              onChange={value => setShowApplied(value === "applied")}
              options={[
                { value: "preview", label: t(key("comparePreview")) },
                { value: "applied", label: t(key("compareApplied")) },
              ]}
            />
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void discard()}>{t(key("discard"))}</Button>
            <Button size="sm" disabled={busy} onClick={apply}>{t(key("apply"))}</Button>
          </div>
        )}
      </footer>
    </>
  );
}

/** The phone sheet's title: the block's name names the sheet. */
function SheetTitleTag({ className, children }: { id: string; className: string; children: React.ReactNode }) {
  return <SheetTitle className={className}>{children}</SheetTitle>;
}
