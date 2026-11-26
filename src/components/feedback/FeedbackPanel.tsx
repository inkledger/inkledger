import { useId, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { ArrowLeft, Download, MessageSquarePlus, Send } from "lucide-react";
import { FEEDBACK_COMMENT_MAX, FEEDBACK_STATUSES, FEEDBACK_TYPES, isFeedbackStatus, isFeedbackType, type FeedbackStatus } from "@contracts/feedback";
import { formatDate } from "@contracts/time";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Chip } from "@/components/app/Chip";
import { ListRow } from "@/components/app/ListRow";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { EmptyState, ErrorState } from "@/components/app/States";
import { surface } from "@/components/app/surface";
import { openFeedback } from "@/lib/flag";
import { downloadBlob } from "@/lib/download";
import { errorText, toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { statusLabel, statusTone, typeLabel } from "./labels";

const ANY = "any";

/** The list's filters, kept in the URL: Back and a reload find the same list. */
function useFilters() {
  const [params, setParams] = useSearchParams();
  const scope: "mine" | "all" = params.get("scope") === "all" ? "all" : "mine";
  const s = params.get("status") ?? "";
  const ty = params.get("type") ?? "";
  const user = Number(params.get("user") ?? "");
  const filters = {
    scope,
    status: isFeedbackStatus(s) ? s : undefined,
    type: isFeedbackType(ty) ? ty : undefined,
    userId: scope === "all" && Number.isSafeInteger(user) && user > 0 ? user : undefined,
  };
  const set = (key: "scope" | "status" | "type" | "user", value: string | null) =>
    setParams(
      prev => {
        const next = new URLSearchParams(prev);
        if (value === null || value === ANY || (key === "scope" && value === "mine")) next.delete(key);
        else next.set(key, value);
        if (key === "scope" && value !== "all") next.delete("user");
        return next;
      },
      { replace: true }
    );
  const clear = () => setParams(prev => {
    const next = new URLSearchParams();
    if (prev.get("scope") === "all") next.set("scope", "all");
    return next;
  }, { replace: true });
  return { filters, set, clear, search: params.toString() };
}

/**
 * Info › Feedback: everyone's own feedback with its state and thread; with readFeedback,
 * everyone's, filtered; with manageFeedback, the state changed and answered. List and
 * detail side by side on a wide panel, one at a time on a narrow one (Back returns).
 */
export function FeedbackPanel({ selected }: { selected: number | null }) {
  const { filters, set, clear, search } = useFilters();
  const access = trpc.feedback.access.useQuery();
  const readAll = access.data?.readAll === true;
  const scope = readAll ? filters.scope : "mine";
  const mine = trpc.feedback.mine.useQuery({ status: filters.status, type: filters.type }, { enabled: scope === "mine" });
  const all = trpc.feedback.all.useQuery({ status: filters.status, type: filters.type, userId: filters.userId }, { enabled: scope === "all" });
  const list = scope === "all" ? all : mine;
  const people = trpc.feedback.all.useQuery(undefined, { enabled: scope === "all", staleTime: 60_000 });
  const authors = [...new Map((people.data ?? []).map(f => [f.userId, f.authorName] as const)).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const exportMut = trpc.feedback.export.useMutation();
  const filtered = Boolean(filters.status || filters.type || filters.userId);
  const suffix = search ? `?${search}` : "";

  const doExport = async (format: "markdown" | "json") => {
    try {
      const file = await exportMut.mutateAsync({ scope, format, filter: { status: filters.status, type: filters.type, userId: scope === "all" ? filters.userId : undefined } });
      downloadBlob(file.name, new Blob([file.content], { type: file.mime }));
      toast.success(t("pages.feedback.list.exported"));
    } catch (e) {
      toastError(e);
    }
  };

  const listPane = (
    <div className={cn("min-w-0 border-b @xl:border-b-0 @xl:border-r", selected !== null && "hidden @xl:block")}>
      {access.data?.manage && access.data.sharingAvailable && <SharingRow on={access.data.sharing} />}
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3 md:px-6">
        {readAll && (
          <SegmentedControl
            label={t("pages.feedback.list.scope")}
            value={scope}
            onChange={v => set("scope", v)}
            options={[
              { value: "mine", label: t("pages.feedback.list.mine") },
              { value: "all", label: t("pages.feedback.list.all") },
            ]}
          />
        )}
        <FilterSelect label={t("pages.feedback.list.status")} value={filters.status ?? ANY} any={t("pages.feedback.list.anyStatus")} options={FEEDBACK_STATUSES.map(s => [s, statusLabel(s)] as const)} onChange={v => set("status", v)} />
        <FilterSelect label={t("pages.feedback.list.type")} value={filters.type ?? ANY} any={t("pages.feedback.list.anyType")} options={FEEDBACK_TYPES.map(s => [s, typeLabel(s)] as const)} onChange={v => set("type", v)} />
        {scope === "all" && (
          <FilterSelect label={t("pages.feedback.list.person")} value={filters.userId ? String(filters.userId) : ANY} any={t("pages.feedback.list.anyone")} options={authors.map(([id, name]) => [String(id), name] as const)} onChange={v => set("user", v)} />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={exportMut.isPending || !list.data?.length}>
              <Download className="mr-1.5 h-4 w-4" aria-hidden />
              {t("pages.feedback.list.export")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void doExport("markdown")}>{t("pages.feedback.list.exportMarkdown")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void doExport("json")}>{t("pages.feedback.list.exportJson")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {list.error ? (
        <ErrorState message={errorText(list.error)} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <div className="grid gap-2 p-5" aria-hidden>
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : list.data.length === 0 ? (
        filtered ? (
          <EmptyState title={t("pages.feedback.list.emptyFiltered")} action={<Button variant="outline" size="sm" onClick={clear}>{t("pages.feedback.list.clearFilters")}</Button>} />
        ) : (
          <EmptyState
            title={t("pages.feedback.list.empty")}
            message={t("pages.feedback.list.emptyText")}
            action={
              <Button size="sm" onClick={() => openFeedback()}>
                <MessageSquarePlus className="mr-1.5 h-4 w-4" aria-hidden />
                {t("ui.feedback.send")}
              </Button>
            }
          />
        )
      ) : (
        <ul aria-label={t("pages.feedback.list.label")} className="divide-y px-3 py-1">
          {list.data.map(f => (
            <li key={f.id}>
              <Link
                to={`/info/feedback/${f.id}${suffix}`}
                aria-current={f.id === selected ? "true" : undefined}
                className={cn("block rounded-md px-2 outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring", f.id === selected && "bg-accent")}
              >
                <ListRow
                  title={<span className="[overflow-wrap:anywhere]">{f.title}</span>}
                  meta={[typeLabel(f.type), formatDate(f.createdAt, "short"), scope === "all" ? f.authorName : null, f.shareState === "sent" ? t("pages.feedback.detail.sharedSent") : null].filter(Boolean).join(" · ")}
                  trail={<Chip variant="dot" tone={statusTone(f.status)}>{statusLabel(f.status)}</Chip>}
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="region">
      <div className="@xl:grid @xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        {listPane}
        <div className={cn("min-w-0", selected === null && "hidden @xl:block")}>
          {selected === null ? (
            <p className="p-6 text-body-sm text-muted-foreground">{t("pages.feedback.list.pick")}</p>
          ) : (
            <FeedbackDetail id={selected} back={`/info/feedback${suffix}`} />
          )}
        </div>
      </div>
    </div>
  );
}

function FilterSelect({ label, value, any, options, onChange }: { label: string; value: string; any: string; options: readonly (readonly [string, string])[]; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="h-control w-auto min-w-[9rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{any}</SelectItem>
        {options.map(([v, l]) => (
          <SelectItem key={v} value={v}>
            {l}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SharingRow({ on }: { on: boolean }) {
  const utils = trpc.useUtils();
  const save = trpc.feedback.setSharing.useMutation({
    onSuccess: r => {
      toast.success(r.enabled ? t("pages.feedback.sharing.on") : t("pages.feedback.sharing.off"));
      void utils.feedback.access.invalidate();
    },
    onError: e => toastError(e),
  });
  const send = trpc.feedback.sendNow.useMutation({
    onSuccess: r => {
      toast.success(r.sent > 0 ? t("pages.feedback.sharing.sendNowDone", { count: r.sent }) : t("pages.feedback.sharing.sendNowNone"));
      void utils.feedback.invalidate();
    },
    onError: e => toastError(e),
  });
  return (
    <div className="flex items-start justify-between gap-3 border-b px-5 py-3 md:px-6">
      <div className="min-w-0">
        <p className="text-body-sm font-medium">{t("pages.feedback.sharing.title")}</p>
        <p className="text-caption text-muted-foreground">{t("pages.feedback.sharing.text")}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {on && (
          <Button variant="outline" size="sm" disabled={send.isPending} onClick={() => send.mutate()}>
            {t("pages.feedback.sharing.sendNow")}
          </Button>
        )}
        <Switch aria-label={t("pages.feedback.sharing.label")} checked={on} disabled={save.isPending} onCheckedChange={v => save.mutate({ enabled: v })} />
      </div>
    </div>
  );
}

/** The author's own, not shared yet: share it now (consent given here), when this server shares. */
function ShareMine({ id, hasScreenshot }: { id: number; hasScreenshot: boolean }) {
  const access = trpc.feedback.access.useQuery();
  const utils = trpc.useUtils();
  const [shot, setShot] = useState(false);
  const share = trpc.feedback.share.useMutation({
    onSuccess: () => {
      toast.success(t("pages.feedback.sharing.shareMineDone"));
      void utils.feedback.invalidate();
    },
    onError: e => toastError(e),
  });
  if (!access.data?.sharing) return null;
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <p className="text-caption text-muted-foreground">{t("pages.feedback.sharing.shareMineText")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" disabled={share.isPending} onClick={() => share.mutate({ id, shareScreenshot: hasScreenshot && shot })}>
          {t("pages.feedback.sharing.shareMine")}
        </Button>
        {hasScreenshot && (
          <label className="flex items-center gap-2 text-caption">
            <Checkbox checked={shot} onCheckedChange={v => setShot(v === true)} />
            {t("pages.feedback.sharing.shareMineScreenshot")}
          </label>
        )}
      </div>
    </div>
  );
}

function FeedbackDetail({ id, back }: { id: number; back: string }) {
  const q = trpc.feedback.get.useQuery({ id });
  const navigate = useNavigate();
  if (q.error) return <ErrorState title={t("pages.feedback.detail.notFound")} message={errorText(q.error)} onRetry={() => void q.refetch()} />;
  if (q.isPending) return <Skeleton className="m-6 h-64" aria-hidden />;
  const f = q.data;
  const shared = f.shareState === "queued" ? t("pages.feedback.detail.sharedQueued") : f.shareState === "sent" ? t("pages.feedback.detail.sharedSent") : f.shareState === "refused" ? t("pages.feedback.detail.sharedRefused") : null;
  return (
    <article className="grid gap-5 p-5 md:p-6" aria-labelledby={`feedback-${f.id}-title`}>
      <Button variant="ghost" size="sm" className="w-fit @xl:hidden" onClick={() => void navigate(back)}>
        <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
        {t("pages.feedback.detail.back")}
      </Button>
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Chip variant="dot" tone={statusTone(f.status)}>{statusLabel(f.status)}</Chip>
          <Chip>{typeLabel(f.type)}</Chip>
          {shared && <Chip tone={f.shareState === "refused" ? "warning" : "info"}>{shared}</Chip>}
        </div>
        <h2 id={`feedback-${f.id}-title`} className="font-display text-heading [overflow-wrap:anywhere]">
          {f.title}
        </h2>
        <p className="text-caption text-muted-foreground">{t("pages.feedback.detail.by", { name: f.authorName || t("pages.feedback.detail.formerUser"), date: formatDate(f.createdAt, "long") })}</p>
        <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">
          {t("pages.feedback.detail.sentFrom", { page: f.page || "-", version: f.appVersion || "-", look: f.look || "-", density: f.density || "-" })}
        </p>
        {f.status === "rejected" && f.statusReason && <p className="text-body-sm [overflow-wrap:anywhere]">{t("pages.feedback.detail.reason", { reason: f.statusReason })}</p>}
      </header>
      {f.body && <p className="whitespace-pre-wrap text-body-sm [overflow-wrap:anywhere]">{f.body}</p>}
      {f.hasScreenshot && (
        <a href={`/api/feedback/${f.id}/screenshot`} target="_blank" rel="noreferrer" className="w-fit">
          <img src={`/api/feedback/${f.id}/screenshot`} alt={t("pages.feedback.detail.screenshotAlt")} className="max-h-72 max-w-full rounded-md border object-contain" {...surface("picture")} />
        </a>
      )}
      {f.mine && f.shareState === null && <ShareMine id={f.id} hasScreenshot={f.hasScreenshot} />}
      {!f.mine && f.canManage && f.shareState === null && <p className="text-caption text-muted-foreground">{t("pages.feedback.sharing.notShared")}</p>}
      {f.canManage && <StatusChanger id={f.id} status={f.status} />}
      <section className="grid gap-3" aria-labelledby={`feedback-${f.id}-thread`}>
        <h3 id={`feedback-${f.id}-thread`} className="text-body font-semibold">
          {t("pages.feedback.detail.thread")}
        </h3>
        {f.thread.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">{t("pages.feedback.detail.noThread")}</p>
        ) : (
          <ol className="grid gap-3">
            {f.thread.map(c => (
              <li key={c.id} className="grid gap-0.5 border-l-2 pl-3">
                <span className="text-caption text-muted-foreground">
                  {(c.origin === "upstream" ? t("pages.feedback.detail.developers") : c.authorName || t("pages.feedback.detail.formerUser")) + " · " + formatDate(c.createdAt, "short")}
                </span>
                {c.statusTo && <span className="text-body-sm font-medium">{t("pages.feedback.detail.statusLine", { from: statusLabel(c.statusFrom ?? ""), to: statusLabel(c.statusTo) })}</span>}
                {c.body && <span className="whitespace-pre-wrap text-body-sm [overflow-wrap:anywhere]">{c.body}</span>}
              </li>
            ))}
          </ol>
        )}
        {(f.mine || f.canManage) && <ReplyForm id={f.id} />}
      </section>
    </article>
  );
}

function ReplyForm({ id }: { id: number }) {
  const field = useId();
  const [body, setBody] = useState("");
  const utils = trpc.useUtils();
  const send = trpc.feedback.comment.useMutation({
    onSuccess: () => {
      setBody("");
      toast.success(t("pages.feedback.detail.replied"));
      void utils.feedback.invalidate();
    },
    onError: e => toastError(e),
  });
  return (
    <form
      className="grid gap-2"
      onSubmit={e => {
        e.preventDefault();
        if (body.trim()) send.mutate({ id, body: body.trim() });
      }}
    >
      <Label htmlFor={field}>{t("pages.feedback.detail.replyLabel")}</Label>
      <Textarea id={field} rows={3} value={body} maxLength={FEEDBACK_COMMENT_MAX} placeholder={t("pages.feedback.detail.replyPlaceholder")} onChange={e => setBody(e.target.value)} />
      <Button type="submit" size="sm" variant="outline" className="w-fit" disabled={send.isPending || !body.trim()}>
        <Send className="mr-1.5 h-4 w-4" aria-hidden />
        {t("pages.feedback.detail.reply")}
      </Button>
    </form>
  );
}

function StatusChanger({ id, status }: { id: number; status: string }) {
  const field = useId();
  const [to, setTo] = useState<FeedbackStatus>(isFeedbackStatus(status) ? status : "new");
  const [reason, setReason] = useState("");
  const utils = trpc.useUtils();
  const save = trpc.feedback.setStatus.useMutation({
    onSuccess: () => {
      setReason("");
      toast.success(t("pages.feedback.detail.statusChanged"));
      void utils.feedback.invalidate();
    },
    onError: e => toastError(e),
  });
  const needsReason = to === "rejected" && !reason.trim();
  return (
    <form
      className="grid gap-2 rounded-md border p-3"
      {...surface("card")}
      onSubmit={e => {
        e.preventDefault();
        if (!needsReason) save.mutate({ id, status: to, ...(to === "rejected" ? { reason: reason.trim() } : {}) });
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`${field}-state`}>{t("pages.feedback.detail.state")}</Label>
        <Select value={to} onValueChange={v => isFeedbackStatus(v) && setTo(v)}>
          <SelectTrigger id={`${field}-state`} className="h-control w-auto min-w-[10rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FEEDBACK_STATUSES.map(s => (
              <SelectItem key={s} value={s}>
                {statusLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" size="sm" disabled={save.isPending || to === status || needsReason}>
          {t("pages.feedback.detail.apply")}
        </Button>
      </div>
      {to === "rejected" && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${field}-reason`}>{t("pages.feedback.detail.reasonLabel")}</Label>
          <Textarea id={`${field}-reason`} rows={2} value={reason} maxLength={FEEDBACK_COMMENT_MAX} placeholder={t("pages.feedback.detail.reasonPlaceholder")} onChange={e => setReason(e.target.value)} />
        </div>
      )}
    </form>
  );
}
