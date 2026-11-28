import { useMemo, useState } from "react";
import { Archive, ArchiveRestore, ArrowUpRight, BellOff, Bell, Check, ChevronLeft, LogOut, MoreHorizontal, Pin, PinOff, RotateCcw, UserPlus } from "lucide-react";
import { useNavigate } from "react-router";
import type { ChatMessageView, ChatThreadView } from "@contracts/chat";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { StatusBadge } from "@/components/StatusBadge";
import { Chip } from "@/components/app/Chip";
import { surface } from "@/components/app/surface";
import { ErrorState } from "@/components/app/States";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useAuth } from "@/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { errorText, toastError } from "@/lib/errorText";
import { issuePath } from "@/lib/issues";
import { projectOf } from "@/lib/projectColors";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { AvatarStack, PersonAvatar } from "./People";
import { nameIn, namesList } from "./chatText";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { TeammatePicker } from "./TeammatePicker";
import { useThreadMessages } from "./useThreadMessages";
import { useThreadOnScreen, useTyping } from "./chatLive";

/**
 * One chat: its issue and people on top (open the issue, add someone, resolve, mute, pin,
 * archive, leave), the messages, who is typing, and the composer. The same in the Chat tab
 * (variant "pane", beside or over the list) and under an issue (variant "inline", bounded).
 */
export function ChatThread({ threadId, variant = "pane", onBack, focusId, onGone }: { threadId: number; variant?: "pane" | "inline"; onBack?: () => void; focusId?: number | null; onGone?: () => void }) {
  const thread = trpc.chat.thread.useQuery({ threadId }, { retry: false });
  const self = useAuth().user?.id ?? null;
  useThreadOnScreen(thread.data ? threadId : null);
  if (thread.isPending)
    return (
      <div className="grid gap-3 p-4" role="status" aria-label={t("pages.chat.messages.loading")}>
        <Skeleton className="h-10" aria-hidden />
        <Skeleton className="h-24" aria-hidden />
      </div>
    );
  if (thread.error) return <ErrorState message={errorText(thread.error)} onRetry={() => void thread.refetch()} />;
  return <Loaded key={threadId} thread={thread.data} self={self} variant={variant} onBack={onBack} focusId={focusId ?? null} onGone={onGone} />;
}

function Loaded({ thread, self, variant, onBack, focusId, onGone }: { thread: ChatThreadView; self: number | null; variant: "pane" | "inline"; onBack?: () => void; focusId: number | null; onGone?: () => void }) {
  const data = useThreadMessages(thread.id, focusId);
  const [replyTo, setReplyTo] = useState<ChatMessageView | null>(null);
  const [editing, setEditing] = useState<ChatMessageView | null>(null);
  const typingIds = useTyping(thread.id, self);
  const typingNames = typingIds.map((id) => nameIn(thread.members, id, self));
  const lastOwn = useMemo(() => [...data.messages].reverse().find((m) => m.authorId === self && m.kind === "text" && !m.deleted) ?? null, [data.messages, self]);
  return (
    <div className={cn("region flex min-h-0 min-w-0 flex-col", variant === "inline" ? "h-[min(32rem,70dvh)] rounded-lg border" : "h-full flex-1")} {...(variant === "inline" ? surface("card") : {})} data-chat-thread={thread.id}>
      <Header thread={thread} self={self} onBack={onBack} onGone={onGone} />
      <MessageList
        thread={thread}
        data={data}
        self={self}
        focusId={focusId}
        className="flex-1"
        onReply={(m) => {
          setEditing(null);
          setReplyTo(m);
        }}
        onEdit={(m) => {
          setReplyTo(null);
          setEditing(m);
        }}
      />
      <p role="status" aria-live="polite" className="min-h-5 shrink-0 truncate px-4 text-caption text-muted-foreground">
        {typingNames.length === 1 ? t("pages.chat.messages.typingOne", { name: typingNames[0] }) : typingNames.length > 1 ? t("pages.chat.messages.typingMany", { names: namesList(typingNames) }) : ""}
      </p>
      <Composer
        thread={thread}
        self={self}
        onSend={data.send}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        editing={editing}
        onDoneEditing={() => setEditing(null)}
        lastOwn={lastOwn}
        onEditLast={setEditing}
        autoFocus={variant === "pane"}
      />
    </div>
  );
}

function Header({ thread, self, onBack, onGone }: { thread: ChatThreadView; self: number | null; onBack?: () => void; onGone?: () => void }) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const refresh = () => Promise.all([utils.chat.thread.invalidate({ threadId: thread.id }), utils.chat.threads.invalidate(), utils.chat.unreadCount.invalidate(), utils.chat.forIssue.invalidate()]);
  const prefs = trpc.chat.prefs.useMutation({ onSuccess: refresh, onError: (e) => toastError(e) });
  const state = trpc.chat.setState.useMutation({ onSuccess: refresh, onError: (e) => toastError(e) });
  const leave = trpc.chat.leave.useMutation({
    onSuccess: () => {
      void refresh();
      onGone?.();
    },
    onError: (e) => toastError(e),
  });
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const others = thread.members.filter((m) => m.userId !== self && !m.left);
  const href = thread.issue.connectionId ? issuePath({ key: thread.issue.key, connectionId: thread.issue.connectionId, remoteId: thread.issue.remoteId }) : null;
  return (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 @m:px-4" {...surface("ground")}>
      {onBack && (
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
          {t("pages.chat.back")}
        </Button>
      )}
      <div className="grid min-w-0 flex-1 basis-48">
        <p className="flex min-w-0 items-center gap-2">
          <ProjectAvatar project={projectOf(thread.issue.key)} size="xs" connectionId={thread.issue.connectionId} />
          <span className="shrink-0 text-caption font-semibold text-muted-foreground">{thread.issue.key}</span>
          {thread.issue.status && <StatusBadge status={thread.issue.status} category={thread.issue.category} />}
          {thread.state === "resolved" && (
            <Chip tone="success" variant="soft">
              {t("pages.chat.header.resolved")}
            </Chip>
          )}
          {thread.muted && <BellOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t("pages.chat.header.muted")} />}
        </p>
        <h2 className="truncate text-body font-semibold" title={thread.issue.title}>
          {thread.issue.title || thread.issue.key}
        </h2>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" aria-label={`${t("pages.chat.header.members")}: ${namesList(others.map((m) => m.name))}`} title={t("pages.chat.header.members")}>
              <AvatarStack names={others.map((m) => m.name)} />
              <span className="tabular-nums">{others.length + 1}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-2">
            <p className="px-1 pb-1 text-caption font-semibold text-muted-foreground">{t("pages.chat.header.membersCount", { count: thread.members.filter((m) => !m.left).length })}</p>
            <ul className="grid max-h-64 grid-cols-[minmax(0,1fr)] overflow-y-auto">
              {thread.members.map((m) => (
                <li key={m.userId} className={cn("flex min-h-target items-center gap-2 px-1 py-1", m.left && "text-muted-foreground")}>
                  <PersonAvatar name={m.name} size="xs" />
                  <span className="truncate text-body-sm">{m.userId === self ? `${m.name} (${t("pages.chat.you")})` : m.name}</span>
                  {m.left && <span className="ml-auto shrink-0 text-caption">{t("pages.chat.header.left")}</span>}
                </li>
              ))}
            </ul>
            <Button variant="outline" size="sm" className="mt-2 w-full" onClick={() => setAdding(true)}>
              <UserPlus className="h-4 w-4" />
              {t("pages.chat.header.add")}
            </Button>
          </PopoverContent>
        </Popover>
        <Button variant="outline" size="sm" disabled={!href} title={href ? undefined : t("pages.chat.header.noIssueAccess")} onClick={() => href && void navigate(href)}>
          <ArrowUpRight className="h-4 w-4" />
          <span className="max-@m:sr-only">{t("pages.chat.header.openIssue")}</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("pages.chat.header.more")} title={t("pages.chat.header.more")}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => state.mutate({ threadId: thread.id, state: thread.state === "resolved" ? "open" : "resolved" })}>
              {thread.state === "resolved" ? <RotateCcw className="h-4 w-4" /> : <Check className="h-4 w-4" />}
              {thread.state === "resolved" ? t("pages.chat.header.reopen") : t("pages.chat.header.resolve")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setAdding(true)}>
              <UserPlus className="h-4 w-4" />
              {t("pages.chat.header.add")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => prefs.mutate({ threadId: thread.id, muted: !thread.muted })}>
              {thread.muted ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
              {thread.muted ? t("pages.chat.header.unmute") : t("pages.chat.header.mute")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => prefs.mutate({ threadId: thread.id, pinned: !thread.pinned })}>
              {thread.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              {thread.pinned ? t("pages.chat.header.unpin") : t("pages.chat.header.pin")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => prefs.mutate({ threadId: thread.id, archived: !thread.archived })}>
              {thread.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
              {thread.archived ? t("pages.chat.header.unarchive") : t("pages.chat.header.archive")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-danger" onSelect={() => setLeaving(true)}>
              <LogOut className="h-4 w-4" />
              {t("pages.chat.header.leave")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {adding && thread.issue.connectionId !== null && (
        <TeammatePicker
          open
          onOpenChange={setAdding}
          connectionId={thread.issue.connectionId}
          issueKey={thread.issue.key}
          addTo={{ threadId: thread.id, exclude: thread.members.filter((m) => !m.left).map((m) => m.userId) }}
          onDone={() => setAdding(false)}
        />
      )}
      <AlertDialog open={leaving} onOpenChange={setLeaving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pages.chat.header.leaveTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("pages.chat.header.leaveMessage")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => leave.mutate({ threadId: thread.id })}>{t("pages.chat.header.leave")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
