import { useMemo, useState } from "react";
import { Check, Users } from "lucide-react";
import type { ChatRef } from "@contracts/chat";
import { EmptyState } from "@/components/app/States";
import { surface } from "@/components/app/surface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import { randomUUID } from "@/lib/randomId";
import { errorText } from "@/lib/errorText";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { PersonAvatar } from "./People";

const newNonce = () => randomUUID();

/**
 * Who to chat with about an issue: teammates (shared teams), the ones who can't join greyed with
 * why. Opening checks each pick against the tracker, with their own connection, before the chat
 * exists; a refusal says who and why, and keeps what was picked and typed.
 */
export function TeammatePicker({
  open,
  onOpenChange,
  connectionId,
  issueKey,
  addTo,
  firstRefs = [],
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: number;
  issueKey: string;
  /** Adding people to this thread (else a chat is opened). */
  addTo?: { threadId: number; exclude: number[] };
  /** Cards the first message carries (a quoted comment). */
  firstRefs?: ChatRef[];
  onDone: (threadId: number) => void;
}) {
  const candidates = trpc.chat.candidates.useQuery({ connectionId, key: issueKey }, { enabled: open, staleTime: 30_000 });
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const openChat = trpc.chat.open.useMutation();
  const add = trpc.chat.addMembers.useMutation();
  const send = trpc.chat.send.useMutation();
  const busy = openChat.isPending || add.isPending || send.isPending;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (candidates.data ?? []).filter((c) => !addTo?.exclude.includes(c.id)).filter((c) => !q || c.name.toLowerCase().includes(q) || c.teams.some((tm) => tm.toLowerCase().includes(q)));
  }, [candidates.data, query, addTo]);

  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async () => {
    if (picked.length === 0 || busy) return;
    setError(null);
    try {
      if (addTo) {
        await add.mutateAsync({ threadId: addTo.threadId, userIds: picked });
        await Promise.all([utils.chat.thread.invalidate({ threadId: addTo.threadId }), utils.chat.threads.invalidate()]);
        onDone(addTo.threadId);
        return;
      }
      const { threadId } = await openChat.mutateAsync({ connectionId, key: issueKey, userIds: picked });
      if (text.trim() || firstRefs.length > 0) await send.mutateAsync({ threadId, body: text, refs: firstRefs, clientNonce: newNonce() });
      await Promise.all([utils.chat.threads.invalidate(), utils.chat.forIssue.invalidate()]);
      onDone(threadId);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const listId = "chat-picker-people";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{addTo ? t("pages.chat.picker.addTitle") : t("pages.chat.picker.title", { key: issueKey })}</DialogTitle>
          <DialogDescription>{t("pages.chat.picker.description", { key: issueKey })}</DialogDescription>
        </DialogHeader>
        {candidates.isPending ? (
          <div className="grid gap-2" role="status" aria-label={t("pages.chat.messages.loading")}>
            <Skeleton className="h-10" aria-hidden />
            <Skeleton className="h-10" aria-hidden />
          </div>
        ) : candidates.error ? (
          <p role="alert" className="text-body-sm text-danger">
            {errorText(candidates.error)}
          </p>
        ) : (candidates.data ?? []).length === 0 ? (
          <EmptyState icon={Users} title={t("pages.chat.picker.none")} message={t("pages.chat.picker.noneMessage")} />
        ) : (
          <>
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("pages.chat.picker.search")} aria-label={t("pages.chat.picker.search")} aria-controls={listId} autoFocus />
            <ul id={listId} className="grid min-h-0 grid-cols-[minmax(0,1fr)] gap-0.5 overflow-y-auto" aria-label={t("pages.chat.picker.search")}>
              {shown.length === 0 && <li className="p-2 text-caption text-muted-foreground">{t("pages.chat.picker.noMatch")}</li>}
              {shown.map((c) => {
                const on = picked.includes(c.id);
                const why = c.ineligible ? t(`pages.chat.picker.reasons.${c.ineligible}`) : null;
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      disabled={!!why}
                      onClick={() => toggle(c.id)}
                      {...surface("control", { on })}
                      className={cn(
                        "grid min-h-target w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-1.5 text-left outline-clear hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 coarse:min-h-touch",
                        on && "bg-primary-soft/60",
                      )}
                    >
                      <PersonAvatar name={c.name} size="sm" />
                      <span className="grid min-w-0">
                        <span className="truncate text-body-sm font-medium">{c.name}</span>
                        <span className="truncate text-caption text-muted-foreground">{why ?? c.teams.join(" · ")}</span>
                      </span>
                      <span className={cn("flex h-5 w-5 items-center justify-center rounded border", on ? "border-primary-strong bg-primary-strong text-primary-foreground" : "border-input")} aria-hidden>
                        {on && <Check className="h-3.5 w-3.5" />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {!addTo && (
              <label className="grid gap-1 text-caption text-muted-foreground">
                {t("pages.chat.picker.firstMessage")}
                <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("pages.chat.picker.firstPlaceholder")} className="min-h-touch resize-none" />
              </label>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-body-sm text-danger [overflow-wrap:anywhere]">
            {error}
          </p>
        )}
        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-caption text-muted-foreground" aria-live="polite">
            {busy ? t("pages.chat.picker.checking") : picked.length > 0 ? t("pages.chat.picker.selected", { count: picked.length }) : ""}
          </span>
          <span className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={picked.length === 0 || busy} onClick={() => void submit()}>
              {addTo ? t("pages.chat.picker.add") : t("pages.chat.picker.start")}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
