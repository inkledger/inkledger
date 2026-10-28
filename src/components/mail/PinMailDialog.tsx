import { useId, useRef, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ChevronDown, ClipboardList, FileUp, Pin, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastError } from "@/lib/errorText";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useToday } from "@/hooks/useToday";
import { addDays, dayKey } from "@contracts/time";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { MailCard, type MailView } from "./MailCard";
import { draftFromFile, draftFromLink, type MailDraft } from "./readMail";

type Due = "none" | "today" | "tomorrow" | "pick";

/** A mail chosen: one kept already (its id), or one still to save. */
type Chosen = { view: MailView; kept: true; id: number } | { view: MailView; kept: false; draft: MailDraft };

const viewOf = (d: MailDraft): MailView => ({
  id: 0,
  subject: d.subject,
  fromName: d.fromName,
  fromAddress: d.fromAddress,
  receivedAt: d.receivedAt ? new Date(d.receivedAt) : null,
  webLink: null,
});

/**
 * "Pin a mail": first the mail (searched in the mailbox when signed in, one
 * kept already, an Outlook link or an .eml file), then where it goes. With
 * `onPick` the place is known (an issue, a TODO): the mail is saved and handed
 * over. Without it, the dialog asks where (an issue, a new TODO, the pinboard).
 */
export function PinMailDialog({
  open,
  onOpenChange,
  onPick,
  initial,
  query,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick?: (mail: MailView) => Promise<void> | void;
  /** A mail already read from a drop or a paste: the dialog only asks what is missing. */
  initial?: MailDraft | null;
  /** Words to search the mailbox for at once (dragged out of Outlook). */
  query?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted while open: each opening starts afresh. */}
        {open && <PinMail onClose={() => onOpenChange(false)} onPick={onPick} initial={initial ?? null} query={query ?? ""} />}
      </DialogContent>
    </Dialog>
  );
}

function PinMail({ onClose, onPick, initial, query }: { onClose: () => void; onPick?: (mail: MailView) => Promise<void> | void; initial: MailDraft | null; query: string }) {
  const save = trpc.mails.save.useMutation();
  const [busy, setBusy] = useState(false);
  // A drop that told everything (a file) goes straight to "where".
  const [chosen, setChosen] = useState<Chosen | null>(initial?.subject ? { view: viewOf(initial), kept: false, draft: initial } : null);

  const choose = async (c: Chosen) => {
    if (!onPick) return setChosen(c);
    setBusy(true);
    try {
      await onPick(c.kept ? c.view : await save.mutateAsync(c.draft));
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return chosen ? (
    <PinWhere chosen={chosen} onBack={() => setChosen(null)} onClose={onClose} />
  ) : (
    <ChooseMail initial={initial} query={query} direct={!!onPick} busy={busy || save.isPending} onChoose={c => void choose(c)} onClose={onClose} />
  );
}

/** Step 1: which mail. */
function ChooseMail({
  initial,
  query: asked,
  direct,
  busy,
  onChoose,
  onClose,
}: {
  initial: MailDraft | null;
  query: string;
  /** The place is known: choosing pins at once. */
  direct: boolean;
  busy: boolean;
  onChoose: (c: Chosen) => void;
  onClose: () => void;
}) {
  const ids = useId();
  const account = trpc.mails.account.useQuery(undefined, { staleTime: 60_000 });
  const signedIn = !!account.data?.account;
  const [typed, setTyped] = useState(asked);
  const query = useDebouncedValue(typed.trim(), 300);
  const found = trpc.mails.search.useQuery({ query: query || undefined }, { enabled: signedIn, staleTime: 30_000, retry: false });
  const kept = trpc.mails.recent.useQuery({ query: query || undefined });
  // A link or a file: folded away when the mailbox can be searched.
  const [others, setOthers] = useState(!!initial);
  const showOthers = others || (account.isSuccess && !signedIn);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("ui.mail.pinTitle")}</DialogTitle>
        <DialogDescription>{signedIn ? t("ui.mail.pinTextSearch") : t("ui.mail.pinText")}</DialogDescription>
      </DialogHeader>

      {!initial && (
        <div className="grid gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              id={`${ids}-search`}
              className="pl-8"
              value={typed}
              autoFocus
              aria-label={signedIn ? t("ui.mail.searchMailbox") : t("ui.mail.searchRecent")}
              placeholder={signedIn ? t("ui.mail.searchMailbox") : t("ui.mail.searchRecent")}
              onChange={e => setTyped(e.target.value)}
            />
          </div>
          {signedIn && (
            <MailList
              label={query ? t("ui.mail.foundInMailbox") : t("ui.mail.latestInInbox")}
              mails={(found.data ?? []).map(d => ({ key: `g:${d.exchangeId ?? d.internetMessageId}`, view: viewOf(d), chosen: { view: viewOf(d), kept: false as const, draft: d } }))}
              loading={found.isPending}
              error={found.error?.message}
              busy={busy}
              onChoose={onChoose}
            />
          )}
          <MailList
            label={t("ui.mail.recent")}
            mails={(kept.data ?? []).map(m => ({ key: `k:${m.id}`, view: m, chosen: { view: m, kept: true as const, id: m.id } }))}
            empty={signedIn ? null : t("ui.mail.noRecent")}
            busy={busy}
            onChoose={onChoose}
          />
          {account.data?.available && !signedIn && (
            <p className="text-caption text-muted-foreground">
              <Link to="/settings/outlook" onClick={onClose} className="underline underline-offset-2 hover:text-foreground">
                {t("ui.mail.signInHint")}
              </Link>
            </p>
          )}
        </div>
      )}

      {initial || !signedIn ? null : (
        <button
          type="button"
          onClick={() => setOthers(o => !o)}
          aria-expanded={showOthers}
          className="flex items-center gap-1 justify-self-start text-caption text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !showOthers && "-rotate-90")} aria-hidden />
          {t("ui.mail.otherWays")}
        </button>
      )}
      {showOthers && <LinkOrFile initial={initial} direct={direct} busy={busy} onChoose={onChoose} onClose={onClose} />}
    </>
  );
}

function MailList({
  label,
  mails,
  loading = false,
  error,
  empty = null,
  busy,
  onChoose,
}: {
  label: string;
  mails: Array<{ key: string; view: MailView; chosen: Chosen }>;
  loading?: boolean;
  error?: string;
  empty?: string | null;
  busy: boolean;
  onChoose: (c: Chosen) => void;
}) {
  if (!loading && !error && mails.length === 0 && !empty) return null;
  return (
    <section className="grid gap-1" aria-label={label}>
      <h3 className="text-caption font-medium text-muted-foreground">{label}</h3>
      {error ? (
        <p className="text-caption text-danger">{error}</p>
      ) : loading ? (
        <p className="text-caption text-muted-foreground">{t("common.loading")}</p>
      ) : mails.length === 0 ? (
        <p className="text-caption text-muted-foreground">{empty}</p>
      ) : (
        <ul className="grid max-h-56 gap-0.5 overflow-y-auto">
          {mails.map(m => (
            <li key={m.key}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onChoose(m.chosen)}
                className="w-full rounded-md p-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MailCard mail={{ ...m.view, webLink: null }} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A pasted Outlook link (its subject typed: a link does not tell it) or an .eml file. */
function LinkOrFile({ initial, direct, busy, onChoose, onClose }: { initial: MailDraft | null; direct: boolean; busy: boolean; onChoose: (c: Chosen) => void; onClose: () => void }) {
  const ids = useId();
  const draft = initial;
  const [link, setLink] = useState("");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const file = useRef<HTMLInputElement>(null);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const d = await draftFromFile(f);
    if (!d) return toastError(new Error(t("ui.mail.notAMail")));
    onChoose({ view: viewOf(d), kept: false, draft: d });
  };

  const linkDraft = draft ?? (link ? draftFromLink(link) : null);
  const linkInvalid = !draft && link.trim() !== "" && !linkDraft;
  const canGo = !!linkDraft && (subject.trim() !== "" || linkDraft.subject !== "") && !busy;

  return (
    <form
      className="grid gap-3"
      onSubmit={e => {
        e.preventDefault();
        if (!linkDraft || !canGo) return;
        const d = { ...linkDraft, subject: subject.trim() || linkDraft.subject };
        onChoose({ view: viewOf(d), kept: false, draft: d });
      }}
    >
      <div className="grid gap-1.5">
        <Label htmlFor={`${ids}-link`}>{t("ui.mail.link")}</Label>
        <div className="flex gap-2">
          <Input
            id={`${ids}-link`}
            value={draft?.webLink ?? link}
            readOnly={!!draft}
            placeholder="https://outlook.office.com/mail/…"
            aria-invalid={linkInvalid || undefined}
            onChange={e => setLink(e.target.value)}
          />
          <Button type="button" variant="outline" onClick={() => file.current?.click()}>
            <FileUp />
            {t("ui.mail.eml")}
          </Button>
          <input ref={file} type="file" accept=".eml,message/rfc822" hidden onChange={e => void onFile(e.target.files?.[0])} />
        </div>
        <p className="text-caption text-muted-foreground">{linkInvalid ? t("ui.mail.notOutlook") : t("ui.mail.linkHint")}</p>
      </div>
      {linkDraft && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-subject`}>{t("ui.mail.subject")}</Label>
          <Input id={`${ids}-subject`} value={subject} maxLength={500} onChange={e => setSubject(e.target.value)} autoFocus={!!draft} />
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={!canGo}>
          {direct ? t("ui.mail.pin") : t("ui.mail.next")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Step 2: where the mail goes. */
function PinWhere({ chosen, onBack, onClose }: { chosen: Chosen; onBack: () => void; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [typed, setTyped] = useState("");
  const query = useDebouncedValue(typed.trim(), 250);
  const issues = trpc.issues.list.useQuery({ search: query, includeDone: !!query, includeUnassigned: !!query, pageSize: 8 }, { staleTime: 30_000 });
  const pin = trpc.mails.pinTo.useMutation();
  const mail = chosen.kept ? { id: chosen.id } : chosen.draft;
  const today = useToday();
  const [due, setDue] = useState<Due>("none");
  const [pickedDay, setPickedDay] = useState("");
  const dueOn = () => (due === "today" ? dayKey(today) : due === "tomorrow" ? dayKey(addDays(today, 1)) : due === "pick" ? pickedDay || null : null);
  const boards = trpc.pinboard.boards.useQuery(undefined, { staleTime: 60_000 });
  // The board in use unless another is chosen; "new" makes one with the name typed.
  const [board, setBoard] = useState("");
  const [newBoard, setNewBoard] = useState("");
  const boardTarget = () => (board === "new" ? { newBoard: newBoard.trim() } : board ? { boardId: Number(board) } : {});

  const go = async (to: Parameters<typeof pin.mutateAsync>[0]["to"], done: (r: Awaited<ReturnType<typeof pin.mutateAsync>>) => string) => {
    try {
      const r = await pin.mutateAsync({ mail, to });
      await Promise.all([utils.mails.invalidate(), utils.todos.invalidate(), utils.pinboard.list.invalidate(), utils.pinboard.boards.invalidate()]);
      toast.success(done(r));
      onClose();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("ui.mail.whereTitle")}</DialogTitle>
        <DialogDescription className="sr-only">{t("ui.mail.whereText")}</DialogDescription>
      </DialogHeader>
      <MailCard mail={chosen.view} className="rounded-md border p-2" />
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Button variant="outline" disabled={pin.isPending || (due === "pick" && !pickedDay)} onClick={() => void go({ todo: { dueOn: dueOn() } }, () => t("ui.mail.pinnedTodo"))}>
            <ClipboardList />
            {t("ui.mail.newTodo")}
          </Button>
          <Select value={due} onValueChange={v => setDue(v as Due)}>
            <SelectTrigger size="sm" aria-label={t("ui.mail.due")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("ui.mail.noDue")}</SelectItem>
              <SelectItem value="today">{t("ui.mail.today")}</SelectItem>
              <SelectItem value="tomorrow">{t("ui.mail.tomorrow")}</SelectItem>
              <SelectItem value="pick">{t("ui.mail.pickDay")}</SelectItem>
            </SelectContent>
          </Select>
          {due === "pick" && <Input type="date" value={pickedDay} aria-label={t("ui.mail.pickDay")} onChange={e => setPickedDay(e.target.value)} />}
        </div>
        <div className="grid gap-1.5">
          <Button variant="outline" disabled={pin.isPending || (board === "new" && !newBoard.trim())} onClick={() => void go({ board: boardTarget() }, r => t("ui.mail.onBoard", { board: r.boardName ?? "" }))}>
            <Pin />
            {t("ui.mail.toPinboard")}
          </Button>
          <Select value={board} onValueChange={setBoard}>
            <SelectTrigger size="sm" aria-label={t("ui.mail.boardChoice")}>
              <SelectValue placeholder={t("ui.mail.boardInUse")} />
            </SelectTrigger>
            <SelectContent>
              {(boards.data ?? []).filter(b => !b.follow).map(b => (
                <SelectItem key={b.id} value={String(b.id)}>
                  {b.name}
                </SelectItem>
              ))}
              <SelectItem value="new">{t("ui.mail.newBoard")}</SelectItem>
            </SelectContent>
          </Select>
          {board === "new" && <Input value={newBoard} maxLength={60} autoFocus aria-label={t("ui.mail.newBoardName")} placeholder={t("ui.mail.newBoardName")} onChange={e => setNewBoard(e.target.value)} />}
        </div>
      </div>
      <div className="grid gap-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="pl-8" value={typed} autoFocus aria-label={t("ui.mail.searchIssue")} placeholder={t("ui.mail.searchIssue")} onChange={e => setTyped(e.target.value)} />
        </div>
        <ul className="grid max-h-64 gap-0.5 overflow-y-auto" aria-label={t("ui.mail.issues")}>
          {(issues.data?.issues ?? []).map(i => (
            <li key={`${i.connectionId}:${i.key}`}>
              <button
                type="button"
                disabled={pin.isPending}
                onClick={() => void go({ issueKey: i.key, connectionId: i.connectionId }, () => t("ui.mail.pinnedTo", { key: i.key }))}
                className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-body-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="shrink-0 text-caption font-medium text-muted-foreground tabular-nums">{i.key}</span>
                <span className="min-w-0 truncate">{i.summary}</span>
              </button>
            </li>
          ))}
          {issues.isSuccess && issues.data.issues.length === 0 && <li className="px-2 py-1.5 text-caption text-muted-foreground">{t("ui.mail.noIssues")}</li>}
        </ul>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onBack}>
          {t("common.back")}
        </Button>
      </DialogFooter>
    </>
  );
}
