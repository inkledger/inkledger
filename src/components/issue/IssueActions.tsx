import { useId, type ReactNode } from "react";
import {
  Bot,
  ClockPlus,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  GitBranch,
  GitCommitHorizontal,
  ListChecks,
  MoreHorizontal,
  Plus,
  Star,
  TerminalSquare,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { AGENT_LINK_MINUTES } from "@contracts/issueCopy";
import { formatDuration } from "@contracts/time";
import { makeTodo } from "@/lib/makeTodo";
import type { useIssueActions } from "@/hooks/useIssueActions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/app/Chip";
import { TimerControls } from "@/components/TimerControls";
import { FavoriteStar } from "@/components/FavoriteStar";
import { MakeTodoButton } from "@/components/todo/MakeTodo";
import { TriageButton, TriageMenuItem } from "@/components/ideas/TriageButton";
import { EditIssueButton } from "@/components/issue/ManageIssue";
import { PinButton, PinMenuItems } from "@/components/issue/PinMenu";
import type { Issue, IssueData } from "@/components/issue/useIssueData";
import { t } from "@/i18n";

type Act = ReturnType<typeof useIssueActions>;

/** Beside the issue's title: import (not in the catalog), restore (hidden), or favorite and edit. */
export function IssueTitleAddon({
  issue: i,
  data: { provider, manage, importIssue },
  connectionId,
  act,
}: {
  issue: Issue;
  data: IssueData;
  /** The connection its link names (the import goes there). */
  connectionId: number | undefined;
  act: Act;
}) {
  if (i.remote)
    return (
      <span className="flex items-center gap-2">
        <span title={t("pages.issueDetail.remoteTitle", { provider })}>
          <Chip>{t("pages.issueDetail.notInCatalog")}</Chip>
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={importIssue.isPending}
          onClick={() => importIssue.mutate({ key: i.key, connectionId })}
        >
          <Plus className="h-4 w-4" /> {t("pages.issueDetail.import")}
        </Button>
      </span>
    );
  if (i.hidden === 1)
    return (
      <span className="flex items-center gap-2">
        <Chip>
          <EyeOff className="h-3 w-3" aria-hidden />{" "}
          {t("pages.issueDetail.hidden")}
        </Chip>
        <Button
          variant="outline"
          size="sm"
          onClick={() => act.restore(i.key, i.connectionId)}
        >
          <Eye className="h-4 w-4" /> {t("pages.issueDetail.restore")}
        </Button>
      </span>
    );
  return (
    <span className="flex items-center gap-2">
      <FavoriteStar
        issueKey={i.key}
        connectionId={i.connectionId}
        favorite={i.favorite === 1}
      />
      {manage.edit && (
        <EditIssueButton
          issueKey={i.key}
          connectionId={i.connectionId}
          title={i.summary}
        />
      )}
    </span>
  );
}

/**
 * The issue's actions: watch, pin, TODO, triage, timer, copy, open on its tracker and
 * log time. `compact` (a desk's pane) keeps the timer and Log time and moves the rest,
 * favorite / restore / import included, into one menu; `menuTop` (the pane's own items)
 * heads that menu, so a pane has one menu, not two.
 */
export function IssueActions({
  issue: i,
  data,
  connectionId,
  act,
  onLogTime,
  compact = false,
  menuTop,
}: {
  issue: Issue;
  data: IssueData;
  connectionId: number | undefined;
  act: Act;
  onLogTime: () => void;
  compact?: boolean;
  menuTop?: ReactNode;
}) {
  const { provider, offers } = data;
  const logTime = (
    <Button onClick={onLogTime}>
      <Plus className="h-4 w-4" />
      {t("pages.issueDetail.logTime")}
    </Button>
  );
  const copyItems = (
    <>
      <DropdownMenuItem onSelect={() => void act.copyKey(i.key)}>
        <Copy className="h-4 w-4" /> {t("pages.issueDetail.copyKey")}
        <DropdownMenuShortcut>C</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => void act.copyBranch(i)}
      >
        <GitBranch className="h-4 w-4" />{" "}
        {t("pages.issueDetail.copyBranch")}
        <DropdownMenuShortcut>B</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void act.copyCommit(i)}>
        <GitCommitHorizontal className="h-4 w-4" /> {t("pages.issueDetail.copyCommit")}
        <DropdownMenuShortcut>M</DropdownMenuShortcut>
      </DropdownMenuItem>
      {!i.remote && <CopyForAgent issueKey={i.key} connectionId={i.connectionId ?? undefined} copy={act.copyForAgent} />}
      {!i.remote && i.containerId && (
        <AnalyzeItem containerId={i.containerId} onSelect={() => void act.copyAnalyze(i.key, i.connectionId ?? undefined)} />
      )}
    </>
  );

  if (compact)
    return (
      <>
        <TimerControls issueKey={i.key} connectionId={i.connectionId} />
        {/* A desk's pane: the main action, its text hidden when the pane is narrow. */}
        <Button size="sm" variant="outline" onClick={onLogTime} title={t("pages.issueDetail.logTime")}>
          <ClockPlus className="h-4 w-4" aria-hidden />
          <span className="group-data-[pane-size=s]/pane:sr-only">{t("pages.issueDetail.logTime")}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("views.issues.row.moreActionsOn", { key: i.key })}
              title={t("views.issues.row.moreActions")}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {menuTop && (
              <>
                {menuTop}
                <DropdownMenuSeparator />
              </>
            )}
            {i.remote ? (
              <DropdownMenuItem
                disabled={data.importIssue.isPending}
                onSelect={() => data.importIssue.mutate({ key: i.key, connectionId })}
              >
                <Plus className="h-4 w-4" /> {t("pages.issueDetail.import")}
              </DropdownMenuItem>
            ) : i.hidden === 1 ? (
              <DropdownMenuItem onSelect={() => void act.restore(i.key, i.connectionId)}>
                <Eye className="h-4 w-4" /> {t("pages.issueDetail.restore")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => void act.toggleFavorite(i.key, i.connectionId)}>
                <Star className="h-4 w-4" />
                {i.favorite === 1 ? t("views.issues.row.unfavorite") : t("views.issues.row.favorite")}
              </DropdownMenuItem>
            )}
            {offers.watch && (
              <DropdownMenuItem
                disabled={act.pending}
                onSelect={() => void act.setWatching(i.key, i.watching !== 1, i.connectionId)}
              >
                <Eye className="h-4 w-4" />
                {i.watching === 1 ? t("views.issues.row.unwatch") : t("views.issues.row.watch")}
              </DropdownMenuItem>
            )}
            <PinMenuItems issueKey={i.key} connectionId={i.connectionId} label={t("pages.issueDetail.pin")} />
            <DropdownMenuItem onSelect={() => makeTodo.ask({ issueKey: i.key, connectionId: i.connectionId ?? undefined })}>
              <ListChecks className="h-4 w-4" aria-hidden />
              {t("views.todos.menuAdd")}
            </DropdownMenuItem>
            {!i.remote && i.connectionId && <TriageMenuItem issueKey={i.key} connectionId={i.connectionId} />}
            <DropdownMenuSeparator />
            {copyItems}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <a href={i.url} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" /> {t("pages.issueDetail.openInJira", { provider })}
              </a>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    );

  return (
    <>
      {offers.watch && (
        <Button
          variant={i.watching === 1 ? "secondary" : "ghost"}
          size="sm"
          aria-pressed={i.watching === 1}
          disabled={act.pending}
          title={
            i.watching === 1
              ? t("pages.issueDetail.watchingTitle", { provider })
              : t("pages.issueDetail.watchTitle", { provider })
          }
          onClick={() =>
            void act.setWatching(i.key, i.watching !== 1, i.connectionId)
          }
        >
          <Eye className="h-4 w-4" />
          {i.watching === 1
            ? t("pages.issueDetail.watching")
            : t("pages.issueDetail.watch")}
        </Button>
      )}
      <PinButton issueKey={i.key} connectionId={i.connectionId} />
      <MakeTodoButton label={t("views.todos.onIssueLabel")} initial="" link={{ issueKey: i.key, connectionId: i.connectionId ?? undefined }} />
      {!i.remote && i.connectionId && <TriageButton issueKey={i.key} connectionId={i.connectionId} />}
      <TimerControls issueKey={i.key} connectionId={i.connectionId} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("pages.issueDetail.copyMenu")}
            title={t("pages.issueDetail.copyTitle")}
          >
            <Copy className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {copyItems}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button asChild variant="outline">
        <a href={i.url} target="_blank" rel="noreferrer">
          {t("pages.issueDetail.openInJira", { provider })}
          <ExternalLink className="h-4 w-4" />
        </a>
      </Button>
      {logTime}
    </>
  );
}

/** "Analyse in the code": only once the project has repositories (Settings → Repositories), and not on a phone (a terminal command). */
function AnalyzeItem({ containerId, onSelect }: { containerId: number; onSelect: () => void }) {
  const projects = trpc.projectPaths.list.useQuery(undefined, { staleTime: 60_000 });
  const repos = projects.data?.find(p => p.id === containerId)?.paths ?? [];
  if (!repos.length) return null;
  return (
    <>
      <DropdownMenuSeparator className="max-lg:hidden" />
      <DropdownMenuItem className="max-lg:hidden" onSelect={onSelect}>
        <TerminalSquare className="h-4 w-4" aria-hidden /> {t("pages.issueDetail.analyze", { count: repos.length })}
      </DropdownMenuItem>
    </>
  );
}

/** "Copy for an agent": the issue as Markdown, attachment links open for the chosen time (docs/work/ideas/issue-copy.md). */
function CopyForAgent({ issueKey, connectionId, copy }: { issueKey: string; connectionId: number | undefined; copy: (key: string, connectionId: number | undefined, minutes: number) => Promise<void> }) {
  const prefs = trpc.settings.get.useQuery(undefined, { staleTime: 60_000 });
  const fallback = prefs.data?.shareLinkMinutes ?? 60;
  const labelId = useId();
  return (
    // A group, not a submenu: a submenu opens beside the menu and leaves a phone's screen.
    <>
      <DropdownMenuSeparator />
      <DropdownMenuGroup aria-labelledby={labelId}>
        <DropdownMenuLabel id={labelId} className="flex items-center gap-2">
          <Bot className="h-4 w-4" aria-hidden /> {t("pages.issueDetail.copyForAgent")}
        </DropdownMenuLabel>
        {AGENT_LINK_MINUTES.map(m => {
          const label = t("pages.issueDetail.copyFor", { duration: formatDuration(m * 60) });
          return (
            <DropdownMenuItem key={m} onSelect={() => void copy(issueKey, connectionId, m)}>
              {m === fallback ? t("pages.issueDetail.copyDefault", { duration: label }) : label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuGroup>
    </>
  );
}
