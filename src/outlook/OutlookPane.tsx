import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, ClipboardList, Layers, Link2, Mail, Pin, PinIcon, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { applyTheme } from "@/lib/theme/apply";
import { addDays, dayKey } from "@contracts/time";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";
import { BrandMark } from "@/components/app/BrandMark";
import { dateFormat, t, useLocale } from "@/i18n";
import { call, PaneError } from "./api";
import { hasFollowed, noteFollowed, office, onMailChanged, openMail, storedKey, storeKey, type OpenMail } from "./office";

type Status = { text: string; tone: "ok" | "bad" | "muted" } | null;
type Places = { issues: string[]; todos: string[]; boards: string[] };
type IssueHit = { key: string; summary: string; connectionId: number };
type Board = { id: number; name: string };
type Buckets = { buckets: { id: number; name: string }[]; active: number | null };
type Due = "none" | "today" | "tomorrow" | "pick";

const KEY_SHAPE = /^ikl_ol_[\w-]{20,}$/;

/** A Markdown link to the mail (its subject's brackets escaped), for a note or anywhere in inkledger. */
const markdownLink = (m: OpenMail) => `[✉ ${(m.subject || t("ui.mail.noSubject")).replace(/[[\]\\]/g, c => `\\${c}`)}](${m.webLink})`;

/**
 * The pane beside a mail in Outlook: connected once with the add-in key, it
 * pins the open mail to an issue, a new TODO or a board, copies its link, and
 * says where it is pinned already. Pinned in Outlook, it follows the mail selected.
 */
export function OutlookPane({ officeReady }: { officeReady: boolean }) {
  useLocale();
  const [phase, setPhase] = useState<"connect" | "pin">(() => (storedKey() ? "pin" : "connect"));
  const [status, setStatus] = useState<Status>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (officeReady) return;
    const timer = setTimeout(() => setStuck(true), 10_000);
    return () => clearTimeout(timer);
  }, [officeReady]);

  const failed = useCallback((e: unknown) => {
    if (e instanceof PaneError && e.status === 401) setPhase("connect");
    setStatus({ text: e instanceof PaneError && e.status === 401 ? e.message : t("ui.outlook.failed", { reason: e instanceof Error ? e.message : String(e) }), tone: "bad" });
  }, []);

  if (!office()) return <Shell><Notice text={t("ui.outlook.noOffice")} /></Shell>;
  if (!officeReady) return <Shell>{stuck ? <Notice text={t("ui.outlook.noAnswer")} /> : <Loading />}</Shell>;
  return (
    <Shell status={status}>
      {phase === "connect" ? (
        <Connect
          onConnected={() => {
            setStatus(null);
            setPhase("pin");
          }}
          onStatus={setStatus}
        />
      ) : (
        <PinMail onStatus={setStatus} onFailed={failed} onChangeKey={() => setPhase("connect")} />
      )}
    </Shell>
  );
}

function Shell({ children, status = null }: { children: ReactNode; status?: Status }) {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-xl bg-canvas p-3 text-body-sm text-foreground">
      <div className="mb-3 flex items-center gap-2">
        <BrandMark className="h-6 w-6" />
        <span className="font-display text-body font-semibold">inkledger</span>
      </div>
      {children}
      <p
        role="status"
        className={cn(
          "mt-3 min-h-5 text-caption [overflow-wrap:anywhere]",
          status?.tone === "ok" && "text-success",
          status?.tone === "bad" && "text-danger",
          status?.tone === "muted" && "text-muted-foreground",
        )}
      >
        {status?.text}
      </p>
    </main>
  );
}

const Loading = () => (
  <div className="flex items-center gap-2 text-muted-foreground">
    <Spinner decorative className="h-4 w-4" />
    {t("ui.outlook.loading")}
  </div>
);
const Notice = ({ text }: { text: string }) => (
  <p className="rounded-lg border bg-card p-3 text-danger" {...surface("card")}>
    {text}
  </p>
);

function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    // One column that never grows past the pane: a long key or title is cut, never pushes it wider.
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border bg-card p-3" aria-label={title} {...surface("card")}>
      {title && <h2 className="text-caption font-medium text-muted-foreground">{title}</h2>}
      {children}
    </section>
  );
}

/** The add-in key, pasted once (Settings → Outlook makes it). */
function Connect({ onConnected, onStatus }: { onConnected: () => void; onStatus: (s: Status) => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const typed = key.trim();
    if (!KEY_SHAPE.test(typed)) return onStatus({ text: t("ui.outlook.badKeyShape"), tone: "bad" });
    setBusy(true);
    await storeKey(typed);
    try {
      await call("GET", "me");
      onConnected();
    } catch (err) {
      onStatus({ text: err instanceof Error ? err.message : String(err), tone: "bad" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel>
      <h1 className="font-display text-heading">{t("ui.outlook.keyTitle")}</h1>
      <p className="text-muted-foreground">{t("ui.outlook.keyText")}</p>
      <form className="grid gap-2" onSubmit={e => void submit(e)}>
        <Label htmlFor="addin-key">{t("ui.outlook.keyLabel")}</Label>
        <Input id="addin-key" type="password" autoComplete="off" autoFocus value={key} onChange={e => setKey(e.target.value)} />
        <Button type="submit" disabled={busy || !key.trim()} className="justify-self-start">
          {t("ui.outlook.keySave")}
        </Button>
      </form>
    </Panel>
  );
}

function PinMail({ onStatus, onFailed, onChangeKey }: { onStatus: (s: Status) => void; onFailed: (e: unknown) => void; onChangeKey: () => void }) {
  const [mail, setMail] = useState<OpenMail | null>(() => openMail());
  // Where the mail on screen is pinned: kept with the mail it was asked for (another mail shows none until known).
  const [known, setKnown] = useState<{ of: string; places: Places } | null>(null);
  const places = mail && known?.of === mail.exchangeId ? known.places : null;
  const [busy, setBusy] = useState(false);
  const clip = useRef<HTMLTextAreaElement>(null);
  const [followed, setFollowed] = useState(hasFollowed);
  // Bumped when the pane's bucket changes: the issues and boards it offers are asked again.
  const [scope, setScope] = useState(0);

  // The user's theme colour; and a pinned pane follows the mail selected.
  useEffect(() => {
    call<{ themeColor: string }>("GET", "me").then(me => applyTheme(me.themeColor, false), onFailed);
    onMailChanged(() => {
      setMail(openMail());
      onStatus(null);
      setFollowed(true);
      void noteFollowed();
    });
  }, [onFailed, onStatus]);

  const refreshPlaces = useCallback(() => {
    if (!mail) return;
    const q = new URLSearchParams({ messageId: mail.internetMessageId ?? "", exchangeId: mail.exchangeId });
    call<Places>("GET", `places?${q.toString()}`).then(p => setKnown({ of: mail.exchangeId, places: p }), onFailed);
  }, [mail, onFailed]);
  useEffect(() => refreshPlaces(), [refreshPlaces]);

  const pin = async (to: unknown, done: (r: { boardName?: string }) => string) => {
    if (!mail) return;
    setBusy(true);
    onStatus({ text: "…", tone: "muted" });
    try {
      const r = await call<{ boardName?: string }>("POST", "pin", { mail, to });
      onStatus({ text: done(r), tone: "ok" });
      refreshPlaces();
    } catch (e) {
      onFailed(e);
    } finally {
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (!mail) return;
    const text = markdownLink(mail);
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // Outlook's frame may not allow the clipboard API: the older copy command, from a hidden field.
      const el = clip.current;
      if (el) {
        el.value = text;
        el.select();
        copied = document.execCommand("copy");
      }
    }
    if (clip.current) clip.current.value = text;
    onStatus(copied ? { text: t("ui.outlook.copied"), tone: "ok" } : { text: t("ui.outlook.copyFailed"), tone: "bad" });
    // Kept in inkledger too: it shows among the mails pinned before, with the mailbox's lasting link when signed in.
    call("POST", "save", mail).catch(onFailed);
  };

  const pinnedTo = places ? [...places.issues, ...places.todos.map(text => t("ui.outlook.todoPlace", { text })), ...places.boards.map(board => t("ui.outlook.boardPlace", { board }))] : [];

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <Panel>
        {mail ? (
          <div className="flex min-w-0 items-start gap-2.5">
            <span aria-hidden className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <p className="font-medium [overflow-wrap:anywhere]">{mail.subject || t("ui.mail.noSubject")}</p>
              <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">
                {[mail.fromName ?? mail.fromAddress, mail.receivedAt ? dateFormat({ dateStyle: "medium", timeStyle: "short" }).format(mail.receivedAt) : null].filter(Boolean).join(" · ")}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground">{t("ui.outlook.noMail")}</p>
        )}
        {pinnedTo.length > 0 && (
          <p className="flex items-start gap-1.5 text-caption text-success" data-testid="pinned-already">
            <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {t("ui.outlook.pinnedAlready", { places: pinnedTo.join(" · ") })}
          </p>
        )}
        <Button variant="ghost" size="sm" className="justify-self-start" disabled={!mail} onClick={() => void copyLink()}>
          <Link2 />
          {t("ui.outlook.copyLink")}
        </Button>
        <textarea ref={clip} id="clip" aria-hidden tabIndex={-1} readOnly className="sr-only" />
      </Panel>

      {mail && (
        <>
          <BucketPicker onChanged={() => setScope(n => n + 1)} onFailed={onFailed} />
          <IssuePicker scope={scope} pinned={places?.issues ?? []} busy={busy} onPick={i => void pin({ issueKey: i.key, connectionId: i.connectionId }, () => t("ui.outlook.pinnedIssue", { key: i.key }))} onFailed={onFailed} />
          <TodoPicker busy={busy} onPin={dueOn => void pin({ todo: { dueOn } }, () => t("ui.outlook.pinnedTodo"))} />
          <BoardPicker scope={scope} busy={busy} onPin={(to, refresh) => void pin({ board: to }, r => (refresh(), t("ui.outlook.pinnedBoard", { board: r.boardName ?? "" })))} onFailed={onFailed} />
        </>
      )}

      {!followed && (
        <p className="flex items-start gap-1.5 text-caption text-muted-foreground">
          <PinIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("ui.outlook.pinTip")}
        </p>
      )}
      <Button variant="link" size="sm" className="justify-self-start px-0 text-muted-foreground" onClick={onChangeKey}>
        {t("ui.outlook.changeKey")}
      </Button>
    </div>
  );
}

/**
 * The pane's own bucket (each device has its own: this one is independent of
 * the server's other devices). It narrows the issues and boards below, and a
 * board made here goes in it. Absent while the user has no buckets.
 */
function BucketPicker({ onChanged, onFailed }: { onChanged: () => void; onFailed: (e: unknown) => void }) {
  const [state, setState] = useState<Buckets | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call<Buckets>("GET", "buckets").then(setState, onFailed);
  }, [onFailed]);
  if (!state || state.buckets.length === 0) return null;
  const choose = async (value: string) => {
    const id = value === "all" ? null : Number(value);
    setBusy(true);
    try {
      const r = await call<{ active: number | null }>("POST", "bucket", { id });
      setState(s => (s ? { ...s, active: r.active } : s));
      onChanged();
    } catch (e) {
      onFailed(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={t("ui.outlook.bucketTitle")}>
      <Select value={state.active === null ? "all" : String(state.active)} onValueChange={v => void choose(v)} disabled={busy}>
        <SelectTrigger size="sm" className="w-full min-w-0" aria-label={t("ui.outlook.bucketTitle")}>
          <Layers aria-hidden />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("ui.outlook.bucketAll")}</SelectItem>
          {state.buckets.map(b => (
            <SelectItem key={b.id} value={String(b.id)}>
              {b.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Panel>
  );
}

function IssuePicker({ scope, pinned, busy, onPick, onFailed }: { scope: number; pinned: string[]; busy: boolean; onPick: (i: IssueHit) => void; onFailed: (e: unknown) => void }) {
  const [typed, setTyped] = useState("");
  const query = useDebouncedValue(typed.trim(), 250);
  const [hits, setHits] = useState<IssueHit[] | null>(null);
  useEffect(() => {
    let current = true;
    call<IssueHit[]>("GET", `issues?q=${encodeURIComponent(query)}`).then(h => current && setHits(h), onFailed);
    return () => {
      current = false;
    };
  }, [query, scope, onFailed]);
  return (
    <Panel title={t("ui.outlook.issueTitle")}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input type="search" className="pl-8" value={typed} aria-label={t("ui.outlook.searchIssue")} placeholder={t("ui.outlook.searchIssue")} onChange={e => setTyped(e.target.value)} />
      </div>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
        {hits === null ? (
          <li className="px-2 py-1.5 text-muted-foreground">{t("ui.outlook.loading")}</li>
        ) : hits.length === 0 ? (
          <li className="px-2 py-1.5 text-muted-foreground">{t("ui.outlook.noIssues")}</li>
        ) : (
          hits.map(i => {
            const on = pinned.includes(i.key);
            return (
              <li key={`${i.connectionId}:${i.key}`}>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={on}
                  title={on ? t("ui.outlook.pinnedMark") : undefined}
                  onClick={() => onPick(i)}
                  className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  <span className="max-w-[45%] shrink-0 truncate text-caption font-medium tabular-nums text-muted-foreground">{i.key}</span>
                  <span className="min-w-0 flex-1 truncate">{i.summary}</span>
                  {on && <Check className="h-3.5 w-3.5 shrink-0 self-center text-success" aria-hidden />}
                </button>
              </li>
            );
          })
        )}
      </ul>
    </Panel>
  );
}

function TodoPicker({ busy, onPin }: { busy: boolean; onPin: (dueOn: string | null) => void }) {
  const [due, setDue] = useState<Due>("none");
  const [picked, setPicked] = useState("");
  const dueOn = () => (due === "today" ? dayKey(new Date()) : due === "tomorrow" ? dayKey(addDays(new Date(), 1)) : due === "pick" ? picked || null : null);
  return (
    <Panel title={t("ui.outlook.todoTitle")}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Select value={due} onValueChange={v => setDue(v as Due)}>
          <SelectTrigger size="sm" className="w-full min-w-0" aria-label={t("ui.mail.due")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("ui.mail.noDue")}</SelectItem>
            <SelectItem value="today">{t("ui.mail.today")}</SelectItem>
            <SelectItem value="tomorrow">{t("ui.mail.tomorrow")}</SelectItem>
            <SelectItem value="pick">{t("ui.mail.pickDay")}</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" className="min-w-0" disabled={busy || (due === "pick" && !picked)} onClick={() => onPin(dueOn())}>
          <ClipboardList />
          {t("ui.outlook.todoAdd")}
        </Button>
      </div>
      {due === "pick" && <Input type="date" value={picked} aria-label={t("ui.mail.pickDay")} onChange={e => setPicked(e.target.value)} />}
    </Panel>
  );
}

function BoardPicker({ scope, busy, onPin, onFailed }: { scope: number; busy: boolean; onPin: (to: { boardId?: number; newBoard?: string }, refresh: () => void) => void; onFailed: (e: unknown) => void }) {
  const [boards, setBoards] = useState<Board[]>([]);
  const [board, setBoard] = useState("");
  const [name, setName] = useState("");
  /** The boards to choose from; `named`: the one just made, chosen. */
  const load = useCallback(
    (named?: string) =>
      call<Board[]>("GET", "boards").then(list => {
        setBoards(list);
        const made = named ? list.find(b => b.name === named) : undefined;
        // The board chosen stays while it is still offered (another bucket may not show it).
        setBoard(b => (made ? String(made.id) : b && b !== "new" && list.some(x => String(x.id) === b) ? b : list[0] ? String(list[0].id) : "new"));
      }, onFailed),
    [onFailed],
  );
  useEffect(() => void load(), [load, scope]);
  const isNew = board === "new";
  return (
    <Panel title={t("ui.outlook.boardTitle")}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <Select value={board} onValueChange={setBoard}>
          <SelectTrigger size="sm" className="w-full min-w-0" aria-label={t("ui.mail.boardChoice")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {boards.map(b => (
              <SelectItem key={b.id} value={String(b.id)}>
                {b.name}
              </SelectItem>
            ))}
            <SelectItem value="new">{t("ui.mail.newBoard")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="min-w-0"
          disabled={busy || !board || (isNew && !name.trim())}
          onClick={() =>
            onPin(isNew ? { newBoard: name.trim() } : { boardId: Number(board) }, () => {
              if (!isNew) return;
              setName("");
              void load(name.trim());
            })
          }
        >
          <Pin />
          {t("ui.outlook.boardPin")}
        </Button>
      </div>
      {isNew && <Input value={name} maxLength={60} autoFocus aria-label={t("ui.mail.newBoardName")} placeholder={t("ui.mail.newBoardName")} onChange={e => setName(e.target.value)} />}
    </Panel>
  );
}
