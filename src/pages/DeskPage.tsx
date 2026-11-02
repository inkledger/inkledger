import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { maximize, park, paneId, removePane, setPreset, unpark, type DeskLayout } from "@contracts/desk";
import { useDesk } from "@/lib/desk/useDesk";
import { isDialogOpen, isTyping } from "@/lib/dom";
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
import { t } from "@/i18n";

const WIDE = "(min-width: 1024px)";

/** A menu (a pane's ⋯) or a dialog is open: Esc and the desk's keys are theirs. */
const somethingOpen = () => isDialogOpen() || document.querySelector('[role="menu"][data-state="open"]') !== null;

/**
 * The Desk (/issues/desk): up to four issues side by side. Wide screens draw them on a
 * grid of the chosen arrangement, with dividers between them; phones show one at a
 * time under a row of tabs (the arrangement saved is left as it is).
 */
export default function DeskPage() {
  const { desk, query, change } = useDesk();
  const wide = useMediaQuery(WIDE, typeof window === "undefined" || window.matchMedia(WIDE).matches);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const panes = desk?.panes ?? [];
  const ids = panes.map(paneId);
  const focused = focusedId && ids.includes(focusedId) ? focusedId : (ids[0] ?? null);
  const showGrid = wide && panes.length > 0;
  const { ref: fitRef, drawn } = useFittedPreset(desk?.preset ?? "single", showGrid);

  const focusPane = (id: string) => {
    setFocusedId(id);
    document.getElementById(`desk-pane-${id}`)?.focus({ preventScroll: true });
  };
  /** Off the desk (or parked): the focus goes to the pane that takes its place, or the one before. */
  const leave = (id: string, how: (d: DeskLayout) => DeskLayout) => {
    const at = ids.indexOf(id);
    const next = ids[at + 1] ?? ids[at - 1] ?? null;
    if (focused === id) setFocusedId(next);
    change(how);
  };

  // The desk's own keys: 1–4 focus a pane, x closes the focused one, Esc restores a maximized one.
  const keys = useRef({ ids, focused, maximized: desk?.maximized ?? null, focusPane, leave, change });
  useEffect(() => {
    keys.current = { ids, focused, maximized: desk?.maximized ?? null, focusPane, leave, change };
  });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || somethingOpen()) return;
      const k = keys.current;
      if (/^[1-4]$/.test(e.key)) {
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

  // A phone shows one at a time: no pane to tell apart, nothing to maximize.
  const several = wide && panes.length > 1;
  const controlsFor = (index: number): PaneControls => {
    const pane = panes[index];
    const id = ids[index];
    return {
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
  const add = (variant: "default" | "outline") => <AddToDesk desk={desk} change={change} onAdded={setFocusedId} variant={variant} />;

  return (
    <div data-fill-page className="flex flex-col lg:min-h-0 lg:flex-1">
      <PageHeader
        title={t("pages.desk.title")}
        documentTitle={panes.length ? t("pages.desk.documentTitle", { count: panes.length }) : t("pages.desk.title")}
        actions={
          panes.length > 0 && (
            <>
              {wide && <LayoutPicker count={panes.length} value={desk.preset} drawn={drawn} onChange={id => change(d => setPreset(d, id), { saveNow: true })} />}
              {wide && add("default")}
            </>
          )
        }
      />
      {desk.maximized && (
        <p role="status" className="sr-only">
          {t("pages.desk.maximized", { key: panes.find(p => paneId(p) === desk.maximized)?.key ?? "" })}
        </p>
      )}
      {panes.length === 0 ? (
        <DeskEmpty add={add("default")} />
      ) : showGrid ? (
        <div ref={fitRef} className="min-h-0 flex-1">
          <Desk desk={desk} drawn={drawn} gridRef={gridRef} controlsFor={controlsFor} onFocusPane={setFocusedId} change={change} />
        </div>
      ) : (
        <PhoneDesk ids={ids} keys={panes.map(p => p.key)} focused={focused} onSelect={focusPane} add={<AddToDesk desk={desk} change={change} onAdded={setFocusedId} variant="ghost" icon />}>
          {panes.map((_, index) => (
            <DeskPane key={ids[index]} id={ids[index]} controls={controlsFor(index)} hidden={ids[index] !== focused} onFocusPane={setFocusedId} />
          ))}
        </PhoneDesk>
      )}
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
        {/* Four keys may not fit a phone's width: they scroll sideways, the "+" stays. */}
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
