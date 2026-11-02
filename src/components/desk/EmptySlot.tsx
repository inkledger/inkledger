import { useMemo, useState, type CSSProperties } from "react";
import { SquarePlus, X } from "lucide-react";
import { paneId, type DeskLayout, type DeskPane } from "@contracts/desk";
import { trpc } from "@/lib/trpc";
import { ISSUE_DRAG_TYPE, readIssueDragData, visibleIssues } from "@/lib/issues";
import { projectOf } from "@/lib/projectColors";
import { IssuePicker } from "@/components/app/IssuePicker";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

/** How many recently opened issues an empty slot offers. */
const RECENT = 4;

/**
 * A slot kept free on the desk: "Open an issue here", with the issue search, the issues
 * opened last (those not on the desk), and room to drop an issue dragged from a list or the
 * board. ✕ closes it (the arrangement follows).
 */
export function EmptySlot({
  id,
  desk,
  hidden = false,
  style,
  onFill,
  onClose,
  onFocusPane,
}: {
  id: string;
  desk: DeskLayout;
  hidden?: boolean;
  style?: CSSProperties;
  onFill: (pane: DeskPane) => void;
  onClose: () => void;
  onFocusPane: (id: string) => void;
}) {
  const issues = trpc.issues.all.useQuery(undefined, { staleTime: 60_000 });
  const [over, setOver] = useState(false);
  const onDesk = useMemo(() => new Set(desk.panes.map(paneId)), [desk.panes]);
  const choices = useMemo(() => visibleIssues(issues.data ?? []).filter(i => !onDesk.has(paneId(i))), [issues.data, onDesk]);
  const recent = useMemo(
    () =>
      choices
        .filter(i => i.seenAt)
        .sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0))
        .slice(0, RECENT),
    [choices]
  );
  const fill = (issue: { connectionId: number; key: string; remoteId: string | null }) => onFill({ connectionId: issue.connectionId, key: issue.key, remoteId: issue.remoteId });
  const titleId = `desk-slot-title-${id}`;

  return (
    <section
      id={`desk-pane-${id}`}
      data-desk-pane={id}
      data-empty-slot
      aria-labelledby={titleId}
      tabIndex={-1}
      hidden={hidden}
      style={style}
      onPointerDownCapture={() => onFocusPane(id)}
      onFocusCapture={() => onFocusPane(id)}
      onDragOver={e => {
        if (!e.dataTransfer.types.includes(ISSUE_DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={e => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setOver(false);
      }}
      onDrop={e => {
        setOver(false);
        const issue = readIssueDragData(e.dataTransfer);
        if (!issue) return;
        e.preventDefault();
        fill(issue);
      }}
      className="relative min-h-0 min-w-0 overflow-y-auto bg-card p-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {/* surface: none — the slot's outline drawn on the pane, not a box standing on it. */}
      <div
        data-over={over || undefined}
        className="flex min-h-full flex-col items-center justify-center rounded-lg border border-dashed border-input px-4 py-8 transition-colors data-[over]:border-ring data-[over]:bg-primary-soft/50"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label={t("pages.desk.slot.close")}
          title={t("pages.desk.slot.close")}
          className="absolute right-4 top-4 text-muted-foreground"
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
        <div className="grid w-full min-w-0 max-w-72 grid-cols-1 gap-3">
          <div className="grid justify-items-center gap-1 text-center">
            <SquarePlus className="h-5 w-5 text-muted-foreground" aria-hidden />
            <h2 id={titleId} className="text-body-sm font-semibold">
              {t("pages.desk.slot.title")}
            </h2>
            <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{over ? t("pages.desk.slot.dropHere") : t("pages.desk.slot.hint")}</p>
          </div>
          <label htmlFor={`desk-slot-search-${id}`} className="sr-only">
            {t("pages.desk.slot.search")}
          </label>
          <IssuePicker
            id={`desk-slot-search-${id}`}
            issues={choices}
            value={null}
            placeholder={t("pages.desk.slot.search")}
            onChange={pick => {
              const row = choices.find(i => i.key === pick.key && i.connectionId === pick.connectionId);
              if (row) fill(row);
            }}
          />
          {recent.length > 0 && (
            <div className="grid grid-cols-1 gap-1">
              <h3 className="text-overline uppercase text-muted-foreground">{t("pages.desk.slot.recent")}</h3>
              <ul className="grid grid-cols-1">
                {recent.map(i => (
                  <li key={paneId(i)}>
                    <button
                      type="button"
                      onClick={() => fill(i)}
                      aria-label={t("pages.desk.slot.open", { key: i.key, summary: i.summary })}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-body-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-touch"
                    >
                      <ProjectAvatar project={projectOf(i.key)} connectionId={i.connectionId} size="xs" />
                      <span className="shrink-0 font-medium">{i.key}</span>
                      <span className="min-w-0 truncate text-muted-foreground">{i.summary}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
