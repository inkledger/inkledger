import { useEffect, useRef, useState } from "react";
import { Clock } from "@/components/app/icons";
import { isTyping } from "@/lib/dom";
import { surface } from "@/components/app/surface";
import { trpc } from "@/lib/trpc";
import { clientId } from "@/lib/device";
import { LogTimeDialog } from "@/components/LogTimeDialog";
import { timerStartOf } from "@/lib/timerLog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

type View = NonNullable<ReturnType<typeof useDecisions>>[number];

const useDecisions = () => trpc.decisions.list.useQuery(undefined, { refetchInterval: 30_000 }).data;

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** How long typing waits before it is sent to the other pages. */
const DRAFT_DEBOUNCE_MS = 300;

/**
 * The questions the app owes the user (log a stopped timer, …), the same on
 * every page and device: whichever page answers first, the others close with
 * who did. Mounted once, in AppLayout.
 */
export function DecisionHost() {
  const list = useDecisions();
  // Answered on this page: gone here at once, whatever the list still says until it refetches.
  const [answeredHere, setAnsweredHere] = useState<ReadonlySet<string>>(new Set());
  const open = list?.find(d => d.kind === "timer-log" && (d.state === "open" || d.state === "resolving") && !answeredHere.has(d.id));
  const [shownId, setShownId] = useState<string | null>(null);
  const [ended, setEnded] = useState<View | null>(null);
  // Asked while the user types elsewhere on this page: a banner first, the dialog once they leave the field.
  const [waiting, setWaiting] = useState<string | null>(null);
  // Another interval of the issue, by hand, in place of the question: out of its life, so a question
  // ended elsewhere meanwhile never takes the typing with it. Closed, the question is back if still open.
  const [another, setAnother] = useState<Another | null>(null);
  // What this page showed ended elsewhere: said once, then gone.
  const openId = open?.id ?? null;
  if (openId !== shownId) {
    const was = shownId ? list?.find(d => d.id === shownId) : undefined;
    setShownId(openId);
    setWaiting(openId && typingElsewhere() ? openId : null);
    if (was && was.state !== "open" && was.state !== "resolving" && str(was.resolution.client) !== clientId()) setEnded(was);
  }
  useEffect(() => {
    if (!waiting) return;
    // Focus moves on (after the blur, to wherever it lands): not typing any more, the dialog opens.
    const left = () => setTimeout(() => !typingElsewhere() && setWaiting(null));
    document.addEventListener("focusout", left);
    return () => document.removeEventListener("focusout", left);
  }, [waiting]);

  return (
    <>
      {open && waiting === open.id && <Waiting issueKey={str(open.payload.issueKey)} onOpen={() => setWaiting(null)} />}
      {open && waiting !== open.id && !another && <TimerLogDecision key={open.id} d={open} onAnswered={() => setAnsweredHere(s => new Set([...s, open.id]))} onAnother={setAnother} />}
      {another && (
        <LogTimeDialog
          issueKey={another.issueKey}
          connectionId={another.connectionId}
          endAt={another.endAt}
          open
          onOpenChange={o => {
            if (!o) setAnother(null);
          }}
        />
      )}
      {ended && !another && <EndedElsewhere d={ended} onClose={() => setEnded(null)} />}
    </>
  );
}

/** Another interval of a timer's issue: it ends before the timer's time at the latest. */
type Another = { issueKey: string; connectionId?: number; endAt?: Date };

function TimerLogDecision({ d, onAnswered, onAnother }: { d: View; onAnswered: () => void; onAnother: (a: Another) => void }) {
  const utils = trpc.useUtils();
  const patch = trpc.decisions.patchDraft.useMutation();
  const dismiss = trpc.decisions.dismiss.useMutation({ onSettled: () => void utils.decisions.list.invalidate() });
  const remote = str(d.draft.comment, str(d.payload.note));
  const [comment, setComment] = useState(remote);
  const [seen, setSeen] = useState(remote);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Logged here: the dialog closes on its own, that is no "Later".
  const answered = useRef(false);
  // Typed on another page: shown here, unless it is this page's own echo.
  if (remote !== seen) {
    setSeen(remote);
    const by = d.draftBy.comment;
    const mine = typeof by === "object" && by !== null && "client" in by && by.client === clientId();
    if (!mine) setComment(remote);
  }
  const latest = useRef(comment);
  // The save on its way, if any: "Later" waits for it too (on a slow server it may land after Later is read).
  const inFlight = useRef<Promise<unknown> | null>(null);
  const send = (v: string) => {
    const p = patch.mutateAsync({ id: d.id, fields: { comment: v } }).finally(() => {
      if (inFlight.current === p) inFlight.current = null;
    });
    inFlight.current = p;
    return p;
  };
  const onComment = (v: string) => {
    setComment(v);
    latest.current = v;
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      void send(v).catch(() => undefined);
    }, DRAFT_DEBOUNCE_MS);
  };
  /** What is still waiting to be sent goes now, and what is on its way lands (before "Later" reads it on the server). */
  const flush = async () => {
    if (pending.current) {
      clearTimeout(pending.current);
      pending.current = null;
      await send(latest.current).catch(() => undefined);
      return;
    }
    await inFlight.current?.catch(() => undefined);
  };
  const issueKey = str(d.payload.issueKey);
  const end = str(d.payload.end);
  const seconds = num(d.payload.seconds);
  return (
    <LogTimeDialog
      issueKey={issueKey}
      connectionId={num(d.payload.connectionId)}
      prefillSeconds={seconds}
      prefillComment={str(d.payload.note)}
      endAt={end ? new Date(end) : undefined}
      fromTimer
      title={t("ui.timerLog.title", { key: issueKey })}
      cancelLabel={t("ui.timerLog.later")}
      shared={{ decision: { id: d.id, revision: d.revision }, openedAt: new Date(d.createdAt), comment, onComment }}
      onAnother={() => {
        // What is typed stays the question's draft, for when it is back.
        void flush();
        onAnother({ issueKey, connectionId: num(d.payload.connectionId), endAt: end && seconds !== undefined ? timerStartOf({ end: new Date(end), seconds }) : undefined });
      }}
      onDone={() => {
        answered.current = true;
        onAnswered();
      }}
      open
      onOpenChange={o => {
        // After the close, a save's onDone has run: only a real "Later" puts it off everywhere.
        if (!o)
          setTimeout(() => {
            if (answered.current || d.state !== "open") return;
            void flush().then(() => dismiss.mutate({ id: d.id, revision: d.revision }));
          });
      }}
    />
  );
}

/** Typing in a field of this page (not one of a question's own dialog). */
function typingElsewhere(): boolean {
  const el = document.activeElement;
  return isTyping(el) && !el?.closest('[role="dialog"]');
}

function Waiting({ issueKey, onOpen }: { issueKey: string; onOpen: () => void }) {
  return (
    <div {...surface("menu")} role="status" aria-live="polite" className="fixed inset-x-4 top-3 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-3 rounded-full border bg-warning-soft px-4 py-1.5 text-body-sm shadow-sm">
      <Clock className="h-4 w-4 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 truncate text-foreground">{t("ui.decisions.waiting", { key: issueKey })}</span>
      <Button size="sm" variant="ghost" className="h-7 px-2.5 text-warning hover:bg-warning/10" onClick={onOpen}>
        {t("ui.decisions.open")}
      </Button>
    </div>
  );
}

function EndedElsewhere({ d, onClose }: { d: View; onClose: () => void }) {
  const device = str(d.resolution.by, "?");
  const reason = str(d.resolution.reason);
  const choice = str(d.resolution.choice);
  const text =
    reason === "resumed" ? t("ui.decisions.resumed", { device }) : reason === "moved" ? t("ui.decisions.moved", { device }) : reason === "discarded" ? t("ui.decisions.discarded", { device }) : reason === "logged" ? t("ui.decisions.gone") : choice === "later" ? t("ui.decisions.laterElsewhere", { device }) : t("ui.decisions.loggedElsewhere", { device });
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("ui.timerLog.title", { key: str(d.payload.issueKey) })}</DialogTitle>
          <DialogDescription role="status">{text}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onClose}>{t("ui.decisions.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
