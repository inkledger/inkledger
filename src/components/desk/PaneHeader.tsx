import { Link } from "react-router";
import { Archive, ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { issuePath } from "@/lib/issues";
import { cn } from "@/lib/utils";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { Chip } from "@/components/app/Chip";
import { ConnectionBadge } from "@/components/app/ConnectionBadge";
import { priorityLabel, priorityTone } from "@/lib/jira";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { IssueActions } from "@/components/issue/IssueActions";
import type { PaneHeaderProps } from "@/components/issue/IssueBody";
import { t } from "@/i18n";

export type PaneControls = {
  /** The key it was put on the desk with (shown until the issue is loaded). */
  issueKey: string;
  connectionId: number;
  active: boolean;
  /** Several panes: focus and maximize mean something. */
  several: boolean;
  maximized: boolean;
  onMaximize: () => void;
  onPark: () => void;
  onClose: () => void;
};

/**
 * A pane's title: its picture, key (to the full page) and title, then its one status and
 * its actions (timer, Log time, and one menu holding the pane's own items first). The
 * pane the keyboard talks to has a line in the focus colour along its top.
 */
export function PaneHeader({ issue: i, data, act, connectionId, onLogTime, controls: c }: PaneHeaderProps & { controls: PaneControls }) {
  const key = i?.key ?? c.issueKey;
  const href = issuePath({ key, connectionId: i?.connectionId ?? c.connectionId, remoteId: i?.remoteId });
  const paneItems = (
    <>
      <DropdownMenuLabel className="text-caption text-muted-foreground">{t("pages.desk.paneMenu")}</DropdownMenuLabel>
      <DropdownMenuItem asChild>
        <Link to={href}>
          <ExternalLink className="h-4 w-4" aria-hidden /> {t("pages.desk.openFull")}
        </Link>
      </DropdownMenuItem>
      {c.several && (
        <DropdownMenuItem onSelect={c.onMaximize}>
          {c.maximized ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
          {c.maximized ? t("pages.desk.restore") : t("pages.desk.maximize")}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onSelect={c.onPark} title={t("pages.desk.parkTitle")}>
        <Archive className="h-4 w-4" aria-hidden /> {t("pages.desk.park")}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={c.onClose}>
        <X className="h-4 w-4" aria-hidden /> {t("pages.desk.close")}
        <span className="ml-auto text-caption text-muted-foreground">X</span>
      </DropdownMenuItem>
    </>
  );
  return (
    // surface: none — the pane's own title row, on the pane like the page's header on the panel.
    <header
      className={cn(
        "sticky top-0 z-10 grid gap-1.5 border-b bg-card px-3 pb-2 pt-2.5",
        c.active && c.several && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-ring"
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ProjectAvatar project={i?.projectKey || key} connectionId={i?.connectionId ?? c.connectionId} size="xs" />
        <Link
          to={href}
          className={cn(
            "shrink-0 rounded-sm text-body-sm font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
            c.active && c.several && "text-primary-strong"
          )}
        >
          {key}
        </Link>
        {i && (
          <h2 className="min-w-0 flex-1 truncate text-body-sm text-muted-foreground" title={i.summary}>
            {i.summary}
          </h2>
        )}
        {c.maximized && (
          // Maximized: the way back in sight, beside the close.
          <Button variant="ghost" size="icon-sm" className="ml-auto shrink-0" aria-label={t("pages.desk.restore")} title={t("pages.desk.restoreTitle")} onClick={c.onMaximize}>
            <Minimize2 className="h-4 w-4" aria-hidden />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("shrink-0", !c.maximized && "ml-auto")}
          aria-label={t("pages.desk.closeOn", { key })}
          title={t("pages.desk.closeOn", { key })}
          onClick={c.onClose}
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      {i && (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="mr-auto flex min-w-0 flex-wrap items-center gap-1.5">
            <StatusBadge status={i.status} category={i.category} className="max-w-full truncate" />
            {i.priority && (
              <Chip variant="dot" tone={priorityTone(i.priority)}>
                {priorityLabel(i.priority)}
              </Chip>
            )}
            <ConnectionBadge connectionId={i.connectionId} />
          </span>
          <IssueActions issue={i} data={data} connectionId={connectionId} act={act} onLogTime={onLogTime} compact menuTop={paneItems} />
        </div>
      )}
    </header>
  );
}
