import { Fragment, useState } from "react";
import { ChevronRight, Download, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/useAuth";
import { dayAndTime } from "@/lib/dates";
import { errorText, toastError } from "@/lib/errorText";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { Chip } from "@/components/app/Chip";
import { EmptyState, ErrorState } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { addDays, parseDayKey } from "@contracts/time";
import { AUDIT_OUTCOMES, auditDiff, isAuditAction, type AuditEventView, type AuditOutcome } from "@contracts/audit";
import { t } from "@/i18n";

/** The groups the "What" filter offers: each is a prefix of the actions it holds. */
const GROUPS = ["auth", "account", "users", "settings", "info", "connections", "store", "modules", "backup", "restore", "team", "worklog", "audit"] as const;
type Group = (typeof GROUPS)[number];

const TARGETS = ["user", "connection", "worklog", "backup", "server", "settings", "team", "audit"] as const;

const OUTCOME_TONE: Record<AuditOutcome, "success" | "warning" | "danger"> = { ok: "success", denied: "warning", failed: "danger" };

type Filters = { group: Group | "all"; outcome: AuditOutcome | "all"; from: string; to: string };
const NO_FILTERS: Filters = { group: "all", outcome: "all", from: "", to: "" };

/** The filters as the API (and the export) reads them. */
function query(f: Filters) {
  const from = f.from ? parseDayKey(f.from) : null;
  const to = f.to ? parseDayKey(f.to) : null;
  return {
    action: f.group === "all" ? undefined : `${f.group}.`,
    outcome: f.outcome === "all" ? undefined : f.outcome,
    from: from ? from.getTime() : undefined,
    // The whole last day.
    to: to ? addDays(to, 1).getTime() - 1 : undefined,
  };
}

function exportUrl(format: "csv" | "json", f: Filters): string {
  const params = new URLSearchParams({ format });
  for (const [k, v] of Object.entries(query(f))) if (v !== undefined) params.set(k, String(v));
  return `/api/audit/export?${params.toString()}`;
}

const actionText = (a: string) => (isAuditAction(a) ? t(`settings.audit.actions.${a}`) : a);

function whoText(e: AuditEventView): string {
  if (e.actorKind === "user") return e.actorLabel || t("settings.audit.actor.unknown");
  const kind = t(`settings.audit.actor.${e.actorKind}`);
  return e.actorLabel ? `${kind} · ${e.actorLabel}` : kind;
}

function targetText(e: AuditEventView): string {
  if (!e.targetType) return "";
  const type = (TARGETS as readonly string[]).includes(e.targetType) ? t(`settings.audit.targets.${e.targetType as (typeof TARGETS)[number]}`) : e.targetType;
  return e.targetId ? `${type} ${e.targetId}` : type;
}

const shown = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** What an event changed: one row per field, before and after (redacted fields as the server kept them). */
function EventDiff({ e }: { e: AuditEventView }) {
  const rows = auditDiff(e.before, e.after);
  if (rows.length === 0) return <p className="text-caption text-muted-foreground">{t("settings.audit.nothingMore")}</p>;
  return (
    <table className="w-full text-left text-caption">
      <thead className="text-muted-foreground">
        <tr>
          <th className="py-1 pr-3 font-medium">{t("settings.audit.field")}</th>
          <th className="py-1 pr-3 font-medium">{t("settings.audit.before")}</th>
          <th className="py-1 font-medium">{t("settings.audit.after")}</th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {rows.map(r => (
          <tr key={r.field}>
            <td className="py-1 pr-3 align-top font-medium">{r.field}</td>
            <td className="py-1 pr-3 align-top text-muted-foreground [overflow-wrap:anywhere]">{shown(r.before)}</td>
            <td className="py-1 align-top [overflow-wrap:anywhere]">{shown(r.after)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The chain walked on the server: intact, or where it breaks. */
function VerifyBadge() {
  const verify = trpc.audit.verify.useQuery(undefined, { staleTime: 60_000 });
  if (verify.isPending) return <Chip variant="dot">{t("settings.audit.verifying")}</Chip>;
  if (verify.error) return <Chip tone="danger">{errorText(verify.error)}</Chip>;
  const v = verify.data;
  return (
    <span className="flex items-center gap-1.5" title={v.ok ? t("settings.audit.verifyHintOk") : t("settings.audit.verifyHintBroken")} role="status">
      {v.ok ? <ShieldCheck className="h-4 w-4 text-success" aria-hidden /> : <ShieldAlert className="h-4 w-4 text-danger" aria-hidden />}
      <Chip tone={v.ok ? "success" : "danger"}>
        {v.ok
          ? v.anchored
            ? t("settings.audit.verifyAnchored", { count: v.checked })
            : t("settings.audit.verifyOk", { count: v.checked })
          : t("settings.audit.verifyBroken", { id: v.badId })}
      </Chip>
    </span>
  );
}

function EventsTable({ filters }: { filters: Filters }) {
  const list = trpc.audit.list.useInfiniteQuery({ ...query(filters), limit: 50 }, { getNextPageParam: last => last.nextCursor ?? undefined });
  const [open, setOpen] = useState<number | null>(null);
  if (list.isPending) return <Skeleton className="h-48" />;
  if (list.error) return <ErrorState message={errorText(list.error)} onRetry={() => void list.refetch()} />;
  const events = list.data.pages.flatMap(p => p.items);
  if (events.length === 0) return <EmptyState title={t("settings.audit.emptyTitle")} message={t("settings.audit.empty")} />;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left text-body-sm">
          <thead className="text-caption text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 pr-3 font-medium">{t("settings.audit.when")}</th>
              <th className="py-2 pr-3 font-medium">{t("settings.audit.who")}</th>
              <th className="py-2 pr-3 font-medium">{t("settings.audit.action")}</th>
              <th className="py-2 pr-3 font-medium">{t("settings.audit.target")}</th>
              <th className="py-2 pr-3 font-medium">{t("settings.audit.outcome")}</th>
              <th className="py-2 pr-3 font-medium">{t("settings.audit.address")}</th>
              <th className="py-2 font-medium">
                <span className="sr-only">{t("settings.audit.details")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {events.map(e => {
              const expanded = open === e.id;
              return (
                <Fragment key={e.id}>
                  <tr className={cn("border-b", expanded && "border-b-0 bg-accent/40")}>
                    <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-muted-foreground">{dayAndTime(e.at)}</td>
                    <td className="py-2 pr-3 font-medium [overflow-wrap:anywhere]">{whoText(e)}</td>
                    <td className="py-2 pr-3 [overflow-wrap:anywhere]">{actionText(e.action)}</td>
                    <td className="py-2 pr-3 text-muted-foreground [overflow-wrap:anywhere]">{targetText(e)}</td>
                    <td className="py-2 pr-3">
                      <Chip variant="dot" tone={OUTCOME_TONE[e.outcome]}>
                        {t(`settings.audit.outcomes.${e.outcome}`)}
                      </Chip>
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-muted-foreground">{e.ip ?? ""}</td>
                    <td className="py-2 text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-expanded={expanded}
                        aria-label={t("settings.audit.detailsOf", { id: e.id })}
                        onClick={() => setOpen(expanded ? null : e.id)}
                      >
                        <ChevronRight className={cn("transition-transform", expanded && "rotate-90")} />
                      </Button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="border-b bg-accent/40">
                      <td colSpan={7} className="px-3 pb-3">
                        <EventDiff e={e} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {list.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button variant="outline" size="sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t("settings.audit.more")}
          </Button>
        </div>
      )}
    </>
  );
}

function Retention({ canSet }: { canSet: boolean }) {
  const utils = trpc.useUtils();
  const info = trpc.audit.settings.useQuery();
  const [refused, setRefused] = useState(0);
  const save = trpc.audit.setRetention.useMutation({
    onSuccess: () => {
      void utils.audit.settings.invalidate();
      void utils.audit.list.invalidate();
      toast.success(t("settings.audit.retentionSaved"));
    },
    onError: e => {
      setRefused(n => n + 1);
      toastError(e);
    },
  });
  if (info.isPending) return <Skeleton className="h-16" />;
  if (info.error) return <ErrorState message={errorText(info.error)} onRetry={() => void info.refetch()} />;
  const { retentionDays, minDays, maxDays, fileMirror } = info.data;
  return (
    <>
      <SettingsRow label={t("settings.audit.retentionLabel")} hint={t("settings.audit.retentionHint", { min: minDays, max: maxDays })}>
        {canSet ? (
          <Input
            key={`${retentionDays}:${refused}`}
            type="number"
            min={minDays}
            max={maxDays}
            aria-label={t("settings.audit.retentionLabel")}
            className="w-28"
            defaultValue={retentionDays}
            onBlur={e => {
              const n = Number(e.target.value);
              if (Number.isInteger(n) && n >= minDays && n <= maxDays) {
                if (n !== retentionDays) save.mutate({ days: n });
              } else e.target.value = String(retentionDays);
            }}
          />
        ) : (
          <span className="text-body-sm">{t("settings.audit.retentionDays", { count: retentionDays })}</span>
        )}
      </SettingsRow>
      <p className="mt-3 text-caption text-muted-foreground">{fileMirror ? t("settings.audit.fileOn") : t("settings.audit.fileOff")}</p>
    </>
  );
}

/** Settings → Audit log: who did what, filtered; what an event changed; export; the chain checked; retention. */
export function AuditSection() {
  const permissions = useAuth().user?.permissions ?? [];
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const filtered = filters.group !== "all" || filters.outcome !== "all" || filters.from !== "" || filters.to !== "";
  const set = (patch: Partial<Filters>) => setFilters(f => ({ ...f, ...patch }));
  return (
    <>
      <SettingsGroup
        id="audit-events"
        title={t("settings.audit.logTitle")}
        description={t("settings.audit.logDescription")}
        keywords={t("settings.audit.keywords")}
        actions={<VerifyBadge />}
      >
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-caption text-muted-foreground">
            {t("settings.audit.what")}
            <Select value={filters.group} onValueChange={v => set({ group: v as Filters["group"] })}>
              <SelectTrigger className="w-44" aria-label={t("settings.audit.what")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("settings.audit.all")}</SelectItem>
                {GROUPS.map(g => (
                  <SelectItem key={g} value={g}>
                    {t(`settings.audit.group.${g}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-caption text-muted-foreground">
            {t("settings.audit.outcome")}
            <Select value={filters.outcome} onValueChange={v => set({ outcome: v as Filters["outcome"] })}>
              <SelectTrigger className="w-36" aria-label={t("settings.audit.outcome")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("settings.audit.all")}</SelectItem>
                {AUDIT_OUTCOMES.map(o => (
                  <SelectItem key={o} value={o}>
                    {t(`settings.audit.outcomes.${o}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-caption text-muted-foreground">
            {t("settings.audit.from")}
            <Input type="date" className="w-40" value={filters.from} onChange={e => set({ from: e.target.value })} />
          </label>
          <label className="grid gap-1 text-caption text-muted-foreground">
            {t("settings.audit.to")}
            <Input type="date" className="w-40" value={filters.to} onChange={e => set({ to: e.target.value })} />
          </label>
          {filtered && (
            <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
              {t("settings.audit.clear")}
            </Button>
          )}
          {permissions.includes("exportAudit") && (
            <span className="ml-auto flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={exportUrl("csv", filters)} download>
                  <Download />
                  {t("settings.audit.exportCsv")}
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={exportUrl("json", filters)} download>
                  <Download />
                  {t("settings.audit.exportJson")}
                </a>
              </Button>
            </span>
          )}
        </div>
        <EventsTable filters={filters} />
      </SettingsGroup>
      <SettingsGroup id="audit-retention" title={t("settings.audit.retentionTitle")} description={t("settings.audit.retentionDescription")} keywords={t("settings.audit.keywords")}>
        <Retention canSet={permissions.includes("manageServer")} />
      </SettingsGroup>
    </>
  );
}
