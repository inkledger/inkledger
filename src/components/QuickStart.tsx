import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Download, Eye, Play, Star } from "lucide-react";
import { addDays, startOfDay } from "@contracts/time";
import { trpc } from "@/lib/trpc";
import { useToday } from "@/hooks/useToday";
import { visibleIssues, issuePath } from "@/lib/issues";
import {
  quickStart,
  type PickedIssue,
  useQuickStartOpen,
  useQuickStartPick,
} from "@/lib/quickStart";
import { useTimers } from "@/hooks/useTimers";
import { useStartTimer } from "@/hooks/useStartTimer";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { TimerRing } from "@/components/TimerControls";
import { toast } from "sonner";
import { Kbd } from "@/components/app/Kbd";
import { useProviderName } from "@/hooks/useConnections";
import { t } from "@/i18n";

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]+-\d+$/;
const RECENT_LIMIT = 6;

type Row = { key: string; connectionId?: number; summary: string; favorite: boolean };

/** A key is unique only per connection: rows are identified by both. */
const idOf = (i: { key: string; connectionId?: number | null }) => `${i.connectionId ?? ""}:${i.key}`;
const rowValue = (r: Row) => `${r.key} ${r.summary} ${r.connectionId ?? ""}`.toLowerCase();

/**
 * "t" anywhere: type a key or a few words, Enter starts the timer.
 * Timers and recent issues first, then favourites, then the whole catalog.
 * ⌘/Ctrl+Enter opens the issue instead. An exact key missing locally is
 * imported from Jira and started in one go.
 */
export function QuickStart() {
  const provider = useProviderName();
  const open = useQuickStartOpen();
  const { onPick, placeholder } = useQuickStartPick();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [value, setValue] = useState("");

  const issues = trpc.issues.all.useQuery(undefined, {
    enabled: open,
    staleTime: 60_000,
  });
  // Always mounted: the window moves with the day, future logs excluded.
  const today = startOfDay(useToday());
  const logs = trpc.worklogs.list.useQuery(
    { from: addDays(today, -14).toISOString(), to: addDays(today, 1).toISOString() },
    { enabled: open, staleTime: 60_000 }
  );
  const { timers } = useTimers();
  const start = useStartTimer({ announce: true });
  const importIssue = trpc.issues.import.useMutation();

  const groups = useMemo(() => {
    const byKey = new Map(
      (issues.data ?? []).map(i => [
        idOf(i),
        { key: i.key, connectionId: i.connectionId, summary: i.summary, favorite: i.favorite === 1 },
      ])
    );
    const row = (ref: { key: string; connectionId?: number }): Row =>
      byKey.get(idOf(ref)) ?? { ...ref, summary: "", favorite: false };
    const seen = new Set<string>();
    const take = (refs: { key: string; connectionId?: number }[], limit = Infinity) => {
      const out: Row[] = [];
      for (const r of refs) {
        if (seen.has(idOf(r)) || out.length >= limit) continue;
        seen.add(idOf(r));
        out.push(row(r));
      }
      return out;
    };
    // Running/paused timers stay listed even on hidden issues.
    const active = take(timers.map(t => ({ key: t.issueKey, connectionId: t.connectionId })));
    const all = visibleIssues(issues.data ?? []);
    const hiddenIds = new Set(
      (issues.data ?? []).filter(i => i.hidden === 1).map(idOf)
    );
    const recent = take(
      (logs.data ?? [])
        .map(w => ({ key: w.issueKey, connectionId: w.connectionId }))
        .filter(w => !hiddenIds.has(idOf(w))),
      RECENT_LIMIT
    );
    const favorites = take(all.filter(i => i.favorite === 1));
    const rest = take(all);
    const rows = [...active, ...recent, ...favorites, ...rest];
    return {
      active,
      recent,
      favorites,
      rest,
      // Keys the catalog knows (on any connection), and rows by cmdk value.
      known: new Set((issues.data ?? []).map(i => i.key)),
      byValue: new Map(rows.map(r => [rowValue(r), r])),
    };
  }, [issues.data, logs.data, timers]);

  const typedKey = search.trim().toUpperCase();
  // Only once the catalog is loaded: before that every key looks "missing".
  const canImport =
    !!issues.data && ISSUE_KEY.test(typedKey) && !groups.known.has(typedKey);
  // A hidden issue is not listed, but typing its exact key offers it back.
  const hiddenMatches = (issues.data ?? []).filter(
    i => i.key === typedKey && i.hidden === 1
  );
  const hiddenMatch = hiddenMatches.length > 0;
  const running = timers.find(t => t.state === "running");

  const close = () => {
    quickStart.set(false);
    setSearch("");
    setValue("");
  };

  const startOn = ({ key, connectionId }: PickedIssue) => {
    close();
    if (onPick) {
      onPick({ key, connectionId });
      return;
    }
    if (running && idOf({ key: running.issueKey, connectionId: running.connectionId }) === idOf({ key, connectionId })) {
      toast.info(t("ui.quickStart.alreadyRunning", { key }));
      return;
    }
    start.mutate({ issueKey: key, connectionId });
  };

  // A typed key names no connection: the server picks it or answers CONFLICT.
  const importAndStart = (key: string) => {
    const pick = onPick;
    close();
    importIssue.mutate(
      { key },
      {
        onSuccess: () => {
          void utils.issues.invalidate();
          if (pick) pick({ key });
          else start.mutate({ issueKey: key });
        },
        onError: e => toast.error(e.message),
      }
    );
  };

  const openIssue = (key: string, connectionId?: number) => {
    close();
    void navigate(issuePath({ key, connectionId }));
  };

  const item = (r: Row) => (
    <CommandItem
      key={idOf(r)}
      value={rowValue(r)}
      onSelect={() => startOn(r)}
    >
      {running && idOf({ key: running.issueKey, connectionId: running.connectionId }) === idOf(r) ? (
        <TimerRing running className="mr-2" />
      ) : (
        <Play className="mr-2 h-4 w-4 text-muted-foreground" />
      )}
      <span className="mr-2 shrink-0 font-medium tabular">{r.key}</span>
      <span className="truncate text-muted-foreground">{r.summary}</span>
      {r.favorite && (
        <Star
          className="ml-auto h-3.5 w-3.5 shrink-0 fill-current text-warning"
          aria-label={t("ui.quickStart.favorite")}
        />
      )}
    </CommandItem>
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={o => (o ? quickStart.set(true) : close())}
      title={t("ui.quickStart.title")}
      description={t("ui.quickStart.description")}
      commandProps={{
        value,
        onValueChange: setValue,
        onKeyDown: e => {
          if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
          // ⌘Invio never falls through to Enter (start / import).
          e.preventDefault();
          const row = groups.byValue.get(value.toLowerCase());
          if (row) openIssue(row.key, row.connectionId);
          else if (ISSUE_KEY.test(typedKey)) openIssue(typedKey);
        },
      }}
    >
      <CommandInput
        placeholder={placeholder ?? t("ui.quickStart.placeholder")}
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        {!canImport && !hiddenMatch && (
          <CommandEmpty>{t("ui.quickStart.empty")}</CommandEmpty>
        )}
        {hiddenMatch && (
          <CommandGroup heading={t("ui.quickStart.hidden")} forceMount>
            <CommandItem
              forceMount
              value={`restore ${typedKey}`}
              onSelect={() => {
                const key = typedKey;
                // Hidden on two connections: key only, the server answers CONFLICT.
                const connectionId =
                  hiddenMatches.length === 1 ? hiddenMatches[0].connectionId : undefined;
                void utils.client.issues.setHidden
                  .mutate({ key, connectionId, hidden: false })
                  .then(() => {
                    void utils.issues.invalidate();
                    startOn({ key, connectionId });
                  })
                  .catch((e: unknown) =>
                    toast.error(e instanceof Error ? e.message : String(e))
                  );
              }}
            >
              <Eye className="mr-2 h-4 w-4 text-muted-foreground" />
              {onPick ? t("ui.quickStart.restorePick") : t("ui.quickStart.restoreStart")}{" "}
              <span className="font-medium">{typedKey}</span>
            </CommandItem>
          </CommandGroup>
        )}
        {canImport && (
          <CommandGroup heading={t("ui.quickStart.fromJira", { provider })} forceMount>
            <CommandItem
              forceMount
              value={`import ${typedKey}`}
              onSelect={() => importAndStart(typedKey)}
            >
              <Download className="mr-2 h-4 w-4 text-muted-foreground" />
              {onPick ? t("ui.quickStart.importPick") : t("ui.quickStart.importStart")}{" "}
              <span className="font-medium">{typedKey}</span>
            </CommandItem>
          </CommandGroup>
        )}
        {groups.active.length > 0 && (
          <CommandGroup heading={t("ui.quickStart.timers")}>{groups.active.map(item)}</CommandGroup>
        )}
        {groups.recent.length > 0 && (
          <CommandGroup heading={t("ui.quickStart.recent")}>
            {groups.recent.map(item)}
          </CommandGroup>
        )}
        {groups.favorites.length > 0 && (
          <CommandGroup heading={t("ui.quickStart.favorites")}>
            {groups.favorites.map(item)}
          </CommandGroup>
        )}
        <CommandGroup heading={t("ui.quickStart.catalog")}>{groups.rest.map(item)}</CommandGroup>
      </CommandList>
      <div className="flex items-center gap-4 border-t px-3 py-2 text-caption text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>{t("ui.keys.enter")}</Kbd>{" "}
          {onPick ? t("ui.quickStart.pick") : t("ui.quickStart.start")}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>{`⌘ ${t("ui.keys.enter")}`}</Kbd>{" "}
          {t("ui.quickStart.open")}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>Esc</Kbd>{" "}
          {t("ui.quickStart.close")}
        </span>
      </div>
    </CommandDialog>
  );
}
