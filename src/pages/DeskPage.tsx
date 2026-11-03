import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { addPane, applySnap, deskIssues, dropIssue, edgeTarget, isIssue, maximize, park, paneId, removePane, sameTarget, setPreset, snapTargets, unpark, type DeskLayout, type DeskPane as Pane, type Edge, type SnapTarget } from "@contracts/desk";
import { trpc } from "@/lib/trpc";
import { useDesk } from "@/lib/desk/useDesk";
import { useSnapDrag } from "@/lib/desk/useSnapDrag";
import { slotNames, targetName } from "@/lib/desk/targetName";
import { announceAdd } from "@/lib/desk/announce";
import { DESK_OPEN_EVENT, paneOf, type DeskOpenDetail } from "@/lib/desk/send";
import { isDialogOpen, isTyping } from "@/lib/dom";
import { hotkeySequence } from "@/lib/hotkeySequence";
import { errorText } from "@/lib/errorText";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { PageHeader } from "@/components/app/PageHeader";
import { ErrorState, PageSpinner } from "@/components/app/States";
import { Desk } from "@/components/desk/Desk";
import { useFittedPreset } from "@/lib/desk/useFittedPreset";
import { DeskPane } from "@/components/desk/DeskPane";
import { DeskEmpty } from "@/components/desk/DeskEmpty";
import { AddToDesk } from "@/components/desk/AddToDesk";
import { LayoutPicker } from "@/components/desk/LayoutPicker";
import { ParkedTray } from "@/components/desk/ParkedTray";
import type { PaneControls } from "@/components/desk/PaneHeader";
import { lazyPart } from "@/components/app/lazyPart";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

const WIDE = "(min-width: 1024px)";

/** "Ask AI" (batch 4c): its code only once opened. */
const DeskChat = lazyPart(() => import("@/components/desk/DeskChat").then(m => m.DeskChat));

/** A menu (a pane's ⋯) or a dialog is open: Esc and the desk's keys are theirs. */
const somethingOpen = () => isDialogOpen() || document.querySelector('[role="menu"][data-state="open"]') !== null;

/** Alt+Shift+arrows send the focused pane to that side of the desk. */
const EDGE_KEYS: Partial<Record<string, Edge>> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom" };

/** Pane `id` sent to `target` (nothing when it is no longer on the desk). */
const snapPane = (desk: DeskLayout, id: string, target: SnapTarget) => {
  const index = desk.panes.findIndex(pane => paneId(pane) === id);
  return index < 0 ? desk : applySnap(desk, index, target);
};

/**
 * The Desk (/issues/desk): up to six issues side by side. Wide screens draw them on a
 * grid of the chosen arrangement, with dividers between them; phones show one at a
 * time under a row of tabs (the arrangement saved is left as it is).
 */
export default function DeskPage() {
  const { desk, query, change } = useDesk();
  const utils = trpc.useUtils();
  const wide = useMediaQuery(WIDE, typeof window === "undefined" || window.matchMedia(WIDE).matches);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const panes = desk?.panes ?? [];
  const ids = panes.map(paneId);
  const names = slotNames(panes);
  const issues = deskIssues({ panes });
  const focused = focusedId && ids.includes(focusedId) ? focusedId : (ids[0] ?? null);
  const showGrid = wide && panes.length > 0;
  const { ref: fitRef, drawn } = useFittedPreset(desk?.preset ?? "single", showGrid);
  // What moving a pane says, written straight into the live region: saying it never redraws the panes.
  const liveRef = useRef<HTMLParagraphElement>(null);
  const announce = (text: string) => {
    if (liveRef.current) liveRef.current.textContent = text;
  };
  const [chatOpen, setChatOpen] = useState(false);
  const chatButton = useRef<HTMLButtonElement>(null);
  const closeChat = () => {
    setChatOpen(false);
    requestAnimationFrame(() => chatButton.current?.focus());
  };
  // "a" opens the chat (or goes back to its question when open).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "a" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || somethingOpen() || hotkeySequence.pending()) return;
      if (!document.querySelector("[data-desk-pane]")) return;
      e.preventDefault();
      setChatOpen(true);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("[data-desk-chat] textarea")?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const snap = useSnapDrag({ grid: gridRef, desk, drawn, announce, onDrop: (id, target) => change(d => snapPane(d, id, target), { saveNow: true }) });
  /** Moved from its menu or by Alt+Shift+arrows: said, and the focus kept on the pane when the move took it away. */
  const moveTo = (id: string, target: SnapTarget) => {
    const at = ids.indexOf(id);
    if (at < 0) return;
    change(d => snapPane(d, id, target), { saveNow: true });
    announce(t("pages.desk.snap.moved", { key: names[at], target: targetName(target, names) }));
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) document.getElementById(`desk-pane-${id}`)?.focus({ preventScroll: true });
    });
  };

  const focusPane = (id: string) => {
    setFocusedId(id);
    document.getElementById(`desk-pane-${id}`)?.focus({ preventScroll: true });
  };
  /** An issue brought in (an empty slot's choice, a drop, Shift-click): already there, it is only focused. */
  const bring = (pane: Pane, how: (d: DeskLayout) => DeskLayout) => {
    const id = paneId(pane);
    if (ids.includes(id)) {
      toast(t("pages.desk.already", { key: pane.key }));
      focusPane(id);
      return;
    }
    change(how, { saveNow: true });
    setFocusedId(id);
    requestAnimationFrame(() => document.getElementById(`desk-pane-${id}`)?.focus({ preventScroll: true }));
  };
  /** Off the desk (or parked): the focus goes to the pane that takes its place, or the one before. */
  const leave = (id: string, how: (d: DeskLayout) => DeskLayout) => {
    const at = ids.indexOf(id);
    const next = ids[at + 1] ?? ids[at - 1] ?? null;
    if (focused === id) setFocusedId(next);
    change(how);
  };

  // The desk's own keys: 1–6 focus a pane, x closes the focused one, Esc restores a maximized one,
  // Alt+Shift+arrows send the focused one to that side.
  const keys = useRef({ ids, focused, maximized: desk?.maximized ?? null, grid: showGrid, focusPane, leave, change, moveTo, bring, desk });
  useEffect(() => {
    keys.current = { ids, focused, maximized: desk?.maximized ?? null, grid: showGrid, focusPane, leave, change, moveTo, bring, desk };
  });
  // Shift-click on an issue link while here: the issue takes the first empty slot (or joins the desk).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const ref = (e as CustomEvent<DeskOpenDetail>).detail;
      void paneOf(utils, ref).then(pane => {
        if (!pane) return;
        const k = keys.current;
        if (k.desk && !k.ids.includes(paneId(pane))) announceAdd(k.desk, addPane(k.desk, pane), pane);
        k.bring(pane, d => addPane(d, pane));
      });
    };
    window.addEventListener(DESK_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(DESK_OPEN_EVENT, onOpen);
  }, [utils]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || isTyping(e.target) || somethingOpen()) return;
      const k = keys.current;
      const edge = EDGE_KEYS[e.key];
      if (e.altKey) {
        const target = edge && e.shiftKey && edgeTarget(edge, k.ids.length);
        if (!target || !k.focused || !k.grid || k.maximized) return;
        e.preventDefault();
        k.moveTo(k.focused, target);
      } else if (/^[1-6]$/.test(e.key)) {
        const id = k.ids[Number(e.key) - 1];
        if (!id) return;
        e.preventDefault();
        if (k.maximized && k.maximized !== id) k.change(d => maximize(d, id), { saveNow: true });
        k.focusPane(id);
      } else if (e.key === "x" && k.focused) {
        e.preventDefault();
        const id = k.focused;
        k.leave(id, d => removePane(d, id));
      } else if (e.key === "Escape" && k.maximized) {
        e.preventDefault();
        k.change(d => maximize(d, null), { saveNow: true });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (query.isPending)
    return (
      <>
        <PageHeader title={t("pages.desk.title")} />
        <PageSpinner />
      </>
    );
  if (!desk)
    return (
      <>
        <PageHeader title={t("pages.desk.title")} />
        <ErrorState message={query.error ? errorText(query.error) : undefined} onRetry={() => void query.refetch()} className="py-20" />
      </>
    );

  const phoneFocused = focused && issues.some(p => paneId(p) === focused) ? focused : (issues[0] ? paneId(issues[0]) : null);
  // A phone shows one at a time: no pane to tell apart, nothing to maximize.
  const several = wide && panes.length > 1;
  // Panes move on a grid of several, none maximized; the menu offers every slot but the pane's own.
  const movable = several && !desk.maximized;
  const controlsFor = (index: number, pane: Pane): PaneControls => {
    const id = ids[index];
    const here: SnapTarget = { kind: "slot", preset: desk.preset, slot: index };
    return {
      id,
      snap: movable ? snap : null,
      moves: movable
        ? snapTargets(panes.length).flatMap(target => (target.kind === "slot" && !sameTarget(target, here) ? [{ preset: target.preset, slot: target.slot, name: targetName(target, names) }] : []))
        : [],
      swaps: movable ? names.flatMap((other, at) => (at === index ? [] : [{ index: at, key: other }])) : [],
      onMove: target => moveTo(id, target),
      issueKey: pane.key,
      connectionId: pane.connectionId,
      active: id === focused,
      several,
      maximized: desk.maximized === id,
      onMaximize: () => {
        setFocusedId(id);
        change(d => maximize(d, d.maximized === id ? null : id), { saveNow: true });
      },
      onPark: () => leave(id, d => park(d, id)),
      onClose: () => leave(id, d => removePane(d, id)),
    };
  };
  const chatFocus = issues.find(p => paneId(p) === (wide ? focused : phoneFocused)) ?? null;
  const add = (variant: "default" | "outline") => <AddToDesk desk={desk} change={change} onAdded={setFocusedId} variant={variant} />;

  return (
    <div data-fill-page className="flex flex-col lg:min-h-0 lg:flex-1">
      <PageHeader
        title={t("pages.desk.title")}
        documentTitle={issues.length ? t("pages.desk.documentTitle", { count: issues.length }) : t("pages.desk.title")}
        actions={
          panes.length > 0 && (
            <>
              {wide && <LayoutPicker count={issues.length} value={desk.preset} drawn={drawn} onChange={id => change(d => setPreset(d, id), { saveNow: true })} />}
              {wide && add("default")}
              <Button ref={chatButton} variant="outline" aria-expanded={chatOpen} title={t("pages.deskChat.openTitle")} onClick={() => (chatOpen ? closeChat() : setChatOpen(true))}>
                <Sparkles aria-hidden />
                {t("pages.deskChat.open")}
              </Button>
            </>
          )
        }
      />
      {desk.maximized && (
        <p role="status" className="sr-only">
          {t("pages.desk.maximized", { key: names[ids.indexOf(desk.maximized)] ?? "" })}
        </p>
      )}
      <p ref={liveRef} role="status" data-desk-live className="sr-only" />
      {panes.length === 0 ? (
        <DeskEmpty add={add("default")} />
      ) : showGrid ? (
        // The chat docks beside the desk, which stays in use (and refits to what is left).
        <div className="flex min-h-0 flex-1">
          <div ref={fitRef} data-workspace-anchor="desk.grid" className="min-h-0 min-w-0 flex-1">
            <Desk
              desk={desk}
              drawn={drawn}
              gridRef={gridRef}
              controlsFor={controlsFor}
              onFocusPane={setFocusedId}
              change={change}
              snap={snap.store}
              onFill={(index, pane) => bring(pane, d => dropIssue(d, pane, { kind: "swap", index }))}
              onDropIssue={(pane, target) => {
                bring(pane, d => dropIssue(d, pane, target));
                announce(t("pages.desk.snap.dropped", { key: pane.key, target: targetName(target, names) }));
              }}
            />
          </div>
          {chatOpen && <DeskChat docked panes={panes} focused={chatFocus} onClose={closeChat} />}
        </div>
      ) : (
        // A phone shows the issues alone: an empty slot is a place on a wide desk.
        <PhoneDesk ids={issues.map(paneId)} keys={issues.map(p => p.key)} focused={phoneFocused} onSelect={focusPane} add={<AddToDesk desk={desk} change={change} onAdded={setFocusedId} variant="ghost" icon />}>
          {panes.map((pane, index) =>
            isIssue(pane) ? <DeskPane key={ids[index]} id={ids[index]} controls={controlsFor(index, pane)} hidden={ids[index] !== phoneFocused} onFocusPane={setFocusedId} /> : null
          )}
        </PhoneDesk>
      )}
      {chatOpen && !showGrid && panes.length > 0 && <DeskChat docked={false} panes={panes} focused={chatFocus} onClose={closeChat} />}
      <ParkedTray
        parked={desk.parked}
        onUnpark={id => {
          change(d => unpark(d, id, focused ?? undefined));
          setFocusedId(id);
        }}
        onRemove={id => change(d => removePane(d, id))}
      />
    </div>
  );
}

/** Phones: a tab per issue (arrows move between them) over the one shown, full width. */
function PhoneDesk({ ids, keys, focused, onSelect, add, children }: { ids: string[]; keys: string[]; focused: string | null; onSelect: (id: string) => void; add: React.ReactNode; children: React.ReactNode }) {
  const onKeyDown = (e: KeyboardEvent) => {
    const at = ids.indexOf(focused ?? "");
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const to = e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : step ? (at + step + ids.length) % ids.length : -1;
    if (to < 0) return;
    e.preventDefault();
    setTimeout(() => document.getElementById(`desk-tab-${ids[to]}`)?.focus());
    onSelect(ids[to]);
  };
  return (
    <>
      <div className="flex items-center gap-1 border-b pl-1 pr-2 md:pl-3">
        {/* Six keys may not fit a phone's width: they scroll sideways, the "+" stays. */}
        <div role="tablist" aria-label={t("pages.desk.tabs")} onKeyDown={onKeyDown} className="flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
          {ids.map((id, i) => (
            <button
              key={id}
              id={`desk-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={id === focused}
              aria-controls={`desk-pane-${id}`}
              tabIndex={id === focused ? 0 : -1}
              onClick={() => onSelect(id)}
              className={cn(
                "min-h-touch shrink-0 border-b-2 px-3 text-body-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                id === focused ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {keys[i]}
            </button>
          ))}
        </div>
        {add}
      </div>
      {children}
    </>
  );
}
