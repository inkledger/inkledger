import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, Clock, CornerUpLeft, Download, FileText, Link2, MessageSquareQuote, MoreHorizontal, Paperclip, Pencil, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatDuration } from "@contracts/time";
import { CHAT_REACTIONS, type ChatFileView, type ChatMemberView, type ChatMessageView, type ChatReaction, type ChatRef, type ChatThreadView } from "@contracts/chat";
import { RichText } from "@/components/app/RichText";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { StatusBadge } from "@/components/StatusBadge";
import { surface } from "@/components/app/surface";
import { EmptyState, ErrorState } from "@/components/app/States";
import { AttachmentViewer } from "@/components/issue/AttachmentViewer";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { trpc } from "@/lib/trpc";
import { errorText, toastError } from "@/lib/errorText";
import { formatBytes } from "@/lib/initials";
import { issuePath } from "@/lib/issues";
import { projectOf } from "@/lib/projectColors";
import { timeOfDay } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { dateFormat, t } from "@/i18n";
import { PersonAvatar } from "./People";
import { chatFileUrl, nameIn, namesList } from "./chatText";
import type { PendingMessage, ThreadMessages } from "./useThreadMessages";

/** Lines of one author within this long read as one group (one name, one avatar). */
const GROUP_MS = 5 * 60_000;

const dayOf = (at: number) => new Date(at).toDateString();

function dayLabel(at: number, now = new Date()): string {
  const d = new Date(at);
  if (d.toDateString() === now.toDateString()) return t("pages.chat.messages.today");
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t("pages.chat.messages.yesterday");
  return dateFormat({ weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" }).format(d);
}

/** What a system line says happened, in words. */
function systemText(m: ChatMessageView, members: readonly ChatMemberView[], self: number | null): string {
  const who = nameIn(members, m.authorId, self);
  const s = m.system;
  if (!s) return "";
  if (s.kind === "added") return t("pages.chat.messages.system.added", { name: who, names: namesList(s.userIds.map((id) => nameIn(members, id, self))) });
  return t(`pages.chat.messages.system.${s.kind}`, { name: who });
}

/**
 * A thread's messages, oldest first: a day's heading, lines of one author grouped, a "New" mark
 * where the reader had read to when it opened, what each member has seen, earlier messages on
 * demand. It follows new messages while the reader is at the bottom; scrolled up, it says
 * there are new ones instead of moving.
 */
export function MessageList({
  thread,
  data,
  self,
  onReply,
  onEdit,
  focusId,
  className,
}: {
  thread: ChatThreadView;
  data: ThreadMessages;
  self: number | null;
  onReply: (m: ChatMessageView) => void;
  onEdit: (m: ChatMessageView) => void;
  /** A message to bring into view and mark (a link to it). */
  focusId?: number | null;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [behind, setBehind] = useState(false);
  const { messages, pending } = data;
  const me = thread.members.find((m) => m.userId === self);
  // Where the reader had read to when the thread opened: the "New" mark stays there while they read.
  // Where the reader had read to when the thread opened: the "New" mark sits on the first line they hadn't read
  // then, and stays there while they read; lines arriving while they watch get none.
  const [firstNew, setFirstNew] = useState<number | null | undefined>(undefined);
  if (firstNew === undefined && data.status === "ready") {
    const read = me?.lastReadId ?? 0;
    setFirstNew(messages.find((m) => m.id > read && m.authorId !== self && m.kind === "text")?.id ?? null);
  }

  // Each other member's receipt, under the latest message they have read.
  const seenAt = useMemo(() => {
    const out = new Map<number, string[]>();
    const ids = messages.map((m) => m.id);
    for (const mem of thread.members) {
      if (mem.userId === self || mem.left || mem.lastReadId === 0) continue;
      let at: number | null = null;
      for (const id of ids) if (id <= mem.lastReadId) at = id;
      if (at !== null) out.set(at, [...(out.get(at) ?? []), mem.name]);
    }
    return out;
  }, [messages, thread.members, self]);

  // Reading: the newest line is read once it is on screen at the bottom of a visible page.
  const markRead = trpc.chat.markRead.useMutation();
  const utils = trpc.useUtils();
  const lastId = messages.at(-1)?.id ?? 0;
  const readUpTo = useRef(me?.lastReadId ?? 0);
  const readNow = useCallback(() => {
    if (!atBottom.current || document.visibilityState !== "visible" || lastId <= readUpTo.current) return;
    readUpTo.current = lastId;
    markRead.mutate(
      { threadId: thread.id, messageId: lastId },
      { onSuccess: () => void Promise.all([utils.chat.unreadCount.invalidate(), utils.chat.threads.invalidate(), utils.chat.forIssue.invalidate()]) },
    );
  }, [lastId, thread.id, markRead, utils]);
  useEffect(() => {
    const timer = setTimeout(readNow, 300);
    document.addEventListener("visibilitychange", readNow);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", readNow);
    };
  }, [readNow]);

  // The first view: the "New" mark (or the asked-for message) in view, else the bottom.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || placed.current || data.status !== "ready") return;
    placed.current = true;
    const target = focusId ?? firstNew ?? null;
    const node = target !== null && target !== undefined ? el.querySelector<HTMLElement>(`[data-message-id="${target}"]`) : null;
    if (node) {
      el.scrollTop = Math.max(0, node.offsetTop - el.clientHeight / 3);
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    } else el.scrollTop = el.scrollHeight;
  }, [data.status, focusId, firstNew]);

  // New lines: followed at the bottom; scrolled up, told.
  const count = messages.length + pending.length;
  const before = useRef({ count, height: 0, first: messages[0]?.id ?? 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const prev = before.current;
    const first = messages[0]?.id ?? 0;
    if (first < prev.first && prev.height > 0) {
      // Earlier messages came in above: what was read stays where it was.
      el.scrollTop += el.scrollHeight - prev.height;
    } else if (count > prev.count) {
      const mine = pending.length > 0 || messages.at(-1)?.authorId === self;
      if (atBottom.current || mine) el.scrollTop = el.scrollHeight;
      else setBehind(true);
    }
    before.current = { count, height: el.scrollHeight, first };
  }, [count, messages, pending.length, self]);

  const [viewer, setViewer] = useState<{ files: ChatFileView[]; index: number } | null>(null);
  const focus = (id: number) => {
    const node = box.current?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if (node) {
      node.scrollIntoView({ block: "center" });
      node.focus({ preventScroll: true });
    }
  };

  if (data.status === "loading")
    return (
      <div className={cn("grid content-start gap-3 p-4", className)} role="status" aria-label={t("pages.chat.messages.loading")}>
        <Skeleton className="h-12" aria-hidden />
        <Skeleton className="h-16" aria-hidden />
        <Skeleton className="h-10" aria-hidden />
      </div>
    );
  if (data.status === "error") return <ErrorState className={className} message={errorText(data.error)} onRetry={() => void data.reload()} />;

  const onlyOpened = messages.every((m) => m.kind === "system") && pending.length === 0;
  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <div
        ref={box}
        role="region"
        aria-label={t("pages.chat.messages.region")}
        tabIndex={0}
        data-chat-messages
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atBottom.current) {
            setBehind(false);
            readNow();
          }
        }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3 outline-clear focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @m:px-4"
      >
        {data.olderMore && (
          <Button variant="ghost" size="sm" className="mx-auto mb-2" disabled={data.loadingOlder} onClick={() => void data.loadOlder()}>
            {t("pages.chat.messages.older")}
          </Button>
        )}
        <ol className="grid grid-cols-[minmax(0,1fr)] content-start">
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const newDay = !prev || dayOf(prev.createdAt) !== dayOf(m.createdAt);
            const grouped = !newDay && !!prev && prev.kind === "text" && m.kind === "text" && prev.authorId === m.authorId && m.createdAt - prev.createdAt < GROUP_MS && m.id !== firstNew;
            return (
              <Fragment key={m.id}>
                {newDay && (
                  <li role="presentation" className="my-2 flex items-center gap-3 text-caption text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
                    {dayLabel(m.createdAt)}
                  </li>
                )}
                {m.id === firstNew && (
                  <li role="presentation" data-chat-new className="my-2 flex items-center gap-3 text-caption font-semibold text-primary-strong after:h-px after:flex-1 after:bg-primary-strong/60">
                    {t("pages.chat.messages.newDivider")}
                  </li>
                )}
                {m.kind === "system" ? (
                  <li data-message-id={m.id} tabIndex={-1} className="my-1 text-center text-caption text-muted-foreground [overflow-wrap:anywhere]">
                    {systemText(m, thread.members, self)} · <time dateTime={new Date(m.createdAt).toISOString()}>{timeOfDay(new Date(m.createdAt))}</time>
                  </li>
                ) : (
                  <Message
                    m={m}
                    grouped={grouped}
                    thread={thread}
                    self={self}
                    focused={focusId === m.id}
                    onReply={() => onReply(m)}
                    onEdit={() => onEdit(m)}
                    onOpenFile={(files, index) => setViewer({ files, index })}
                    onJump={focus}
                  />
                )}
                {seenAt.has(m.id) && (
                  <li className="mb-1 flex justify-end gap-1" aria-label={t("pages.chat.messages.seenBy", { names: namesList(seenAt.get(m.id)!) })}>
                    {seenAt.get(m.id)!.map((n) => (
                      <PersonAvatar key={n} name={n} size="xs" className="h-4 w-4" />
                    ))}
                  </li>
                )}
              </Fragment>
            );
          })}
          {pending.map((p) => (
            <Pending key={p.nonce} p={p} self={self} members={thread.members} onRetry={() => data.retry(p.nonce)} onDiscard={() => data.discard(p.nonce)} />
          ))}
        </ol>
        {onlyOpened && <EmptyState className="my-auto py-8" icon={MessageSquareQuote} title={t("pages.chat.messages.emptyTitle")} message={t("pages.chat.messages.emptyMessage")} />}
      </div>
      {behind && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-2 left-1/2 -translate-x-1/2"
          onClick={() => {
            const el = box.current;
            if (el) el.scrollTop = el.scrollHeight;
            setBehind(false);
          }}
        >
          <ArrowDown className="h-4 w-4" aria-hidden />
          {t("pages.chat.messages.jump")}
        </Button>
      )}
      <AttachmentViewer
        items={(viewer?.files ?? []).map((f) => ({ id: String(f.id), filename: f.name, mimeType: f.contentType, size: f.size }))}
        index={viewer?.index ?? null}
        onIndex={(index) => setViewer((v) => (v ? { ...v, index } : v))}
        onClose={() => setViewer(null)}
        srcOf={(a) => chatFileUrl(Number(a.id))}
      />
    </div>
  );
}

/** One member's line: name and time (first of a group), words, cards, files, the answer it gives, reactions, its actions. */
function Message({
  m,
  grouped,
  thread,
  self,
  focused,
  onReply,
  onEdit,
  onOpenFile,
  onJump,
}: {
  m: ChatMessageView;
  grouped: boolean;
  thread: ChatThreadView;
  self: number | null;
  focused: boolean;
  onReply: () => void;
  onEdit: () => void;
  onOpenFile: (files: ChatFileView[], index: number) => void;
  onJump: (id: number) => void;
}) {
  const name = nameIn(thread.members, m.authorId, self);
  const mine = m.authorId !== null && m.authorId === self;
  const at = new Date(m.createdAt);
  return (
    <li
      data-message-id={m.id}
      data-mine={mine || undefined}
      tabIndex={-1}
      aria-label={grouped ? undefined : `${name}, ${timeOfDay(at)}`}
      className={cn("group grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-2 rounded-md px-1 outline-clear focus-visible:ring-2 focus-visible:ring-ring", grouped ? "pt-0.5" : "mt-2 pt-1", focused && "bg-primary-soft/40")}
    >
      <span className="pt-0.5">{!grouped && <PersonAvatar name={m.authorId === null ? "?" : nameIn(thread.members, m.authorId, null)} size="sm" />}</span>
      <div className="grid min-w-0 gap-1.5">
      {!grouped ? (
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-body-sm font-semibold">{name}</span>
          <time className="shrink-0 text-caption text-muted-foreground tabular-nums" dateTime={at.toISOString()}>
            {timeOfDay(at)}
          </time>
          {m.editedAt !== null && !m.deleted && <span className="shrink-0 text-caption text-muted-foreground">({t("pages.chat.messages.edited")})</span>}
          {m.jiraCommentId && (
            <span className="inline-flex shrink-0 items-center gap-1 text-caption text-primary-strong">
              <Send className="h-3.5 w-3.5" aria-hidden />
              {t("pages.chat.messages.onTracker")}
            </span>
          )}
        </p>
      ) : (
        <span className="sr-only">{`${name}, ${timeOfDay(at)}`}</span>
      )}
        {m.replyTo && (
          <button
            type="button"
            onClick={() => onJump(m.replyTo!.id)}
            title={t("pages.chat.messages.jumpTo")}
            className="flex min-w-0 items-center gap-1.5 border-l-2 border-border pl-2 text-left text-caption text-muted-foreground outline-clear hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <CornerUpLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="shrink-0">{t("pages.chat.messages.replyTo", { name: nameIn(thread.members, m.replyTo.authorId, self) })}</span>
            <span className="truncate italic">{m.replyTo.deleted ? t("pages.chat.messages.deleted") : m.replyTo.preview}</span>
          </button>
        )}
        {m.deleted ? (
          <p className="text-body-sm italic text-muted-foreground">{t("pages.chat.messages.deleted")}</p>
        ) : (
          <>
            {m.doc ? <RichText doc={m.doc} images={new Map()} variant="text" collapseAfter={1600} connectionId={thread.issue.connectionId} /> : null}
            {m.refs.length > 0 && <Cards refs={m.refs} thread={thread} />}
            {m.files.length > 0 && <Files files={m.files} onOpen={(i) => onOpenFile(m.files, i)} />}
          </>
        )}
        {m.reactions.length > 0 && <Reactions m={m} thread={thread} self={self} />}
        {grouped && m.editedAt !== null && !m.deleted && <span className="text-caption text-muted-foreground">({t("pages.chat.messages.edited")})</span>}
      </div>
      <MessageActions m={m} thread={thread} self={self} mine={mine} onReply={onReply} onEdit={onEdit} />
    </li>
  );
}

/** A line not written yet: shown as sent, with Retry and Discard when it failed. */
function Pending({ p, self, members, onRetry, onDiscard }: { p: PendingMessage; self: number | null; members: readonly ChatMemberView[]; onRetry: () => void; onDiscard: () => void }) {
  return (
    <li data-pending={p.state} className="mt-2 grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2 px-1 pt-1">
      <span className="pt-0.5">
        <PersonAvatar name={nameIn(members, self, null)} size="sm" />
      </span>
      <div className="grid min-w-0 gap-1">
        <p className="flex items-baseline gap-2">
          <span className="text-body-sm font-semibold">{t("pages.chat.you")}</span>
          <span className={cn("text-caption", p.state === "failed" ? "text-danger" : "text-muted-foreground")} role={p.state === "failed" ? "alert" : "status"}>
            {p.state === "failed" ? t("pages.chat.messages.failed") : t("pages.chat.messages.sending")}
          </span>
        </p>
        {p.body && <p className={cn("whitespace-pre-wrap text-body-sm [overflow-wrap:anywhere]", p.state === "sending" && "text-muted-foreground")}>{p.body}</p>}
        {p.files.length > 0 && <p className="text-caption text-muted-foreground">{t("pages.chat.filesOnly", { count: p.files.length })}</p>}
        {p.state === "failed" && (
          <div className="flex flex-wrap items-center gap-1.5">
            {p.error && <span className="text-caption text-danger [overflow-wrap:anywhere]">{p.error}</span>}
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t("pages.chat.messages.retry")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDiscard}>
              {t("pages.chat.messages.discard")}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/** Cards in a message: an issue, a worklog, a tracker comment, as their sender saw them. */
function Cards({ refs, thread }: { refs: ChatRef[]; thread: ChatThreadView }) {
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-1.5 @m:grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]">
      {refs.map((r, i) => (
        <li key={i} {...surface("card")} className="min-w-0 rounded-lg border bg-card p-2.5">
          <Card r={r} thread={thread} />
        </li>
      ))}
    </ul>
  );
}

function Card({ r, thread }: { r: ChatRef; thread: ChatThreadView }) {
  if (r.kind === "issue") {
    const href = thread.issue.connectionId ? issuePath({ key: r.key, connectionId: thread.issue.connectionId }) : null;
    const body = (
      <span className="grid min-w-0 gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <ProjectAvatar project={projectOf(r.key)} size="xs" connectionId={thread.issue.connectionId} />
          <span className="shrink-0 text-body-sm font-semibold">{r.key}</span>
          {href && <ArrowUpRight className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        </span>
        <span className="line-clamp-2 text-body-sm [overflow-wrap:anywhere]">{r.title}</span>
        {r.status && <StatusBadge status={r.status} category={r.category} className="justify-self-start" />}
      </span>
    );
    return href ? (
      <a href={href} className="block rounded-md outline-clear focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${t("pages.chat.messages.card.issue")} ${r.key}: ${r.title}`}>
        {body}
      </a>
    ) : (
      body
    );
  }
  if (r.kind === "worklog")
    return (
      <span className="grid min-w-0 gap-1">
        <span className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {t("pages.chat.messages.card.worklog")} · {r.key} · {dateFormat({ day: "numeric", month: "short" }).format(new Date(r.date + "T12:00:00"))}
          </span>
        </span>
        <span className="text-body font-semibold tabular-nums">{formatDuration(r.seconds)}</span>
        {r.comment && <span className="line-clamp-3 whitespace-pre-wrap text-body-sm [overflow-wrap:anywhere]">{r.comment}</span>}
      </span>
    );
  return (
    <blockquote className="grid min-w-0 gap-1 border-l-2 border-primary-strong/60 pl-2">
      <span className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
        <MessageSquareQuote className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          {t("pages.chat.messages.card.comment", { author: r.author })} · {r.key}
        </span>
      </span>
      <span className="line-clamp-4 whitespace-pre-wrap text-body-sm [overflow-wrap:anywhere]">{r.excerpt}</span>
    </blockquote>
  );
}

/** Pictures as a grid (their own proportions, no shift while loading); other files as chips. */
function Files({ files, onOpen }: { files: ChatFileView[]; onOpen: (index: number) => void }) {
  const pictures = files.map((f, i) => ({ f, i })).filter(({ f }) => f.contentType.startsWith("image/"));
  const others = files.map((f, i) => ({ f, i })).filter(({ f }) => !f.contentType.startsWith("image/"));
  return (
    <div className="grid gap-1.5">
      {pictures.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {pictures.map(({ f, i }) => (
            <li key={f.id}>
              <button type="button" onClick={() => onOpen(i)} {...surface("picture")} className="block overflow-clip rounded-lg border bg-muted outline-clear focus-visible:ring-2 focus-visible:ring-ring" aria-label={f.name}>
                <img src={chatFileUrl(f.id)} alt="" width={f.width ?? undefined} height={f.height ?? undefined} loading="lazy" className="h-auto max-h-60 w-auto max-w-[min(20rem,100%)] object-contain" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {others.map(({ f, i }) => (
            <li key={f.id} {...surface("chip")} className="flex min-w-0 max-w-full items-center gap-1 rounded-md border bg-card pl-2">
              <button type="button" onClick={() => onOpen(i)} className="flex min-h-target min-w-0 items-center gap-1.5 text-left text-body-sm outline-clear focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-touch">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{f.name}</span>
                <span className="shrink-0 text-caption text-muted-foreground">{formatBytes(f.size)}</span>
              </button>
              <Button variant="ghost" size="icon-sm" asChild>
                <a href={chatFileUrl(f.id, true)} download={f.name} aria-label={`${t("views.issue.viewer.download")} ${f.name}`} title={t("views.issue.viewer.download")}>
                  <Download className="h-4 w-4" />
                </a>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The reactions a message has: each with who, a press adds or takes back one's own. */
function Reactions({ m, thread, self }: { m: ChatMessageView; thread: ChatThreadView; self: number | null }) {
  const react = useReact();
  return (
    <ul className="flex flex-wrap gap-1">
      {m.reactions.map((r) => {
        const mineToo = self !== null && r.userIds.includes(self);
        const who = namesList(r.userIds.map((id) => nameIn(thread.members, id, self)));
        return (
          <li key={r.emoji}>
            <button
              type="button"
              aria-pressed={mineToo}
              title={t("pages.chat.messages.reacted", { names: who, emoji: r.emoji })}
              onClick={() => react(m.id, r.emoji, !mineToo)}
              {...surface("chip", { on: mineToo })}
              className={cn(
                "inline-flex min-h-target items-center gap-1 rounded-full border px-2 text-caption tabular-nums outline-clear focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-touch",
                mineToo ? "border-primary-strong/60 bg-primary-soft text-primary-strong" : "bg-card text-muted-foreground",
              )}
            >
              <span aria-hidden>{r.emoji}</span>
              {r.userIds.length}
              <span className="sr-only">{t("pages.chat.messages.reacted", { names: who, emoji: r.emoji })}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function useReact() {
  const mutation = trpc.chat.react.useMutation({ onError: (e) => toastError(e) });
  return (messageId: number, emoji: ChatReaction, on: boolean) => mutation.mutate({ messageId, emoji, on });
}

/** A message's actions, always there (quiet at rest): reply, react, copy its link, publish, edit and remove one's own. */
function MessageActions({ m, thread, self, mine, onReply, onEdit }: { m: ChatMessageView; thread: ChatThreadView; self: number | null; mine: boolean; onReply: () => void; onEdit: () => void }) {
  const react = useReact();
  const publish = trpc.chat.publish.useMutation({
    onSuccess: () => toast.success(t("pages.chat.messages.published")),
    onError: (e) => toastError(e),
  });
  const remove = trpc.chat.remove.useMutation({ onError: (e) => toastError(e) });
  const publishFiles = trpc.chat.publishFiles.useMutation({
    onSuccess: () => toast.success(t("pages.chat.messages.filesPublished")),
    onError: (e) => toastError(e),
  });
  const [confirm, setConfirm] = useState(false);
  if (m.deleted) return <span />;
  const link = () => {
    const url = new URL(`/notifications?tab=chat&thread=${thread.id}&msg=${m.id}`, location.origin).href;
    void navigator.clipboard?.writeText(url).then(() => toast.success(t("pages.chat.messages.linkCopied")));
  };
  const canPublish = !m.jiraCommentId && !!m.body.trim() && thread.issue.connectionId !== null;
  return (
    <span className="flex items-start">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t("pages.chat.messages.actions")} title={t("pages.chat.messages.actions")} className="text-muted-foreground group-hover:text-foreground group-focus-within:text-foreground">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <div className="flex justify-between gap-0.5 px-1 py-1" role="group" aria-label={t("pages.chat.messages.react")}>
            {CHAT_REACTIONS.map((e) => {
              const on = self !== null && m.reactions.some((r) => r.emoji === e && r.userIds.includes(self));
              return (
                <DropdownMenuItem key={e} className={cn("justify-center px-1.5", on && "bg-primary-soft")} aria-label={t("pages.chat.messages.reactWith", { emoji: e })} onSelect={() => react(m.id, e, !on)}>
                  <span aria-hidden>{e}</span>
                </DropdownMenuItem>
              );
            })}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onReply}>
            <CornerUpLeft className="h-4 w-4" />
            {t("pages.chat.messages.reply")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={link}>
            <Link2 className="h-4 w-4" />
            {t("pages.chat.messages.copyLink")}
          </DropdownMenuItem>
          {canPublish && (
            <DropdownMenuItem disabled={publish.isPending} onSelect={() => publish.mutate({ messageId: m.id })}>
              <Send className="h-4 w-4" />
              {t("pages.chat.messages.publish")}
            </DropdownMenuItem>
          )}
          {m.files.length > 0 && thread.issue.connectionId !== null && (
            <DropdownMenuItem disabled={publishFiles.isPending} onSelect={() => publishFiles.mutate({ messageId: m.id })}>
              <Paperclip className="h-4 w-4" />
              {t("pages.chat.messages.publishFiles")}
            </DropdownMenuItem>
          )}
          {mine && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil className="h-4 w-4" />
                {t("pages.chat.messages.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-danger" onSelect={() => setConfirm(true)}>
                <Trash2 className="h-4 w-4" />
                {t("pages.chat.messages.remove")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pages.chat.messages.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("pages.chat.messages.removeMessage")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => remove.mutate({ messageId: m.id })}>{t("pages.chat.messages.remove")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  );
}

