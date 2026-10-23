import { useRef, useState } from "react";
import { Link } from "react-router";
import { Copy, FilePlus2, Flag, Lock, MoreHorizontal, MoveRight, X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { useToday } from "@/hooks/useToday";
import { dayLabel } from "@/lib/todoDay";
import { parseSteps } from "@contracts/todo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  clampToCanvas,
  NOTE_COLORS,
  NOTE_SIZE,
  type NoteColor,
} from "@contracts/pinboard";
import { dayKey, formatDate } from "@contracts/time";
import { projectOf } from "@/lib/projectColors";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";
import { t } from "@/i18n";
import { issuePath } from "@/lib/issues";

export type PostItData = {
  id: number;
  issueKey: string | null;
  connectionId?: number | null;
  note: string;
  color: string;
  x: number;
  y: number;
  rotation: number;
  /** Stacking order (the last moved on top) */
  z: number;
  summary: string | null;
  status: string | null;
  /** A private note hung on the board: its id, text and date (the text is the note's, not `note`). */
  issueNoteId?: number | null;
  noteBody?: string | null;
  noteCreatedAt?: Date | null;
  /** A TODO hung on the board, as it is now: its text is the TODO's, ticked here is ticked there. */
  todo?: { id: number; text: string; dueOn: string | null; done: boolean; priority: number; steps: string; issueKey: string | null; connectionId: number | null } | null;
};

/** Stored colour names → washi tape tones (--tape-1…5): the colour is on the tape. */
const TONE: Record<NoteColor, number> = {
  orange: 1,
  yellow: 2,
  green: 3,
  blue: 4,
  pink: 5,
};
const TAPE_ORDER: NoteColor[] = ["orange", "yellow", "green", "blue", "pink"];
const tape = (c: NoteColor) => `hsl(var(--tape-${TONE[c]}))`;

/**
 * A note on the board: one warm grainy paper for all, held by a strip of
 * washi tape whose colour tells the notes apart; barely tilted. Moved by dragging (pointer capture) or the keyboard
 * (arrows); Enter writes, Delete unpins, "o" opens the issue. Nothing moves
 * on hover; the position is a transform so dragging never re-lays out.
 */
export function PostIt({
  n,
  zoom,
  onMove,
  onNudge,
  onFront,
  onNote,
  onColor,
  onRemove,
  onCreateIssue,
  onOpen,
  onDrag,
  boards = [],
  onCopy,
  readOnly = false,
  onTodoTick,
}: {
  n: PostItData;
  zoom: number;
  onMove: (x: number, y: number) => void;
  /** Keyboard: move by a step from the latest position. */
  onNudge: (dx: number, dy: number) => void;
  onFront: () => void;
  onNote: (note: string) => void;
  onColor: (color: NoteColor) => void;
  onRemove: () => void;
  onCreateIssue: () => void;
  onOpen: () => void;
  /** Where it is while being dragged (null when let go): the red strings follow it. */
  onDrag?: (p: { x: number; y: number } | null) => void;
  /** The other boards it can go to (pinned by hand). */
  boards?: { id: number; name: string }[];
  /** To another board: moved, or a copy left here too. */
  onCopy?: (boardId: number, move: boolean) => void;
  /** On a board that follows a tag: shown as the tracker says; moved and recoloured, never written on or taken off. */
  readOnly?: boolean;
  /** A TODO's post-it: ticked or unticked here. */
  onTodoTick?: (done: boolean) => void;
}) {
  // A private note hung here: written on, it is the note's text that changes.
  const isNote = !!n.issueNoteId;
  // A TODO hung here: the same, with the TODO's text.
  const todo = n.todo ?? null;
  const today = useToday();
  const body = todo ? todo.text : isNote ? (n.noteBody ?? "") : n.note;
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  // Where it was dropped, kept until the cache says so: no frame back at the
  // old place between the release and the optimistic update.
  // `from` is where the cache had it at the drop: any change there (the drop
  // itself, or the truth back after a failed save) ends the hold.
  const [settled, setSettled] = useState<{ x: number; y: number; from: { x: number; y: number } } | null>(null);
  if (settled && (settled.from.x !== n.x || settled.from.y !== n.y || (settled.x === n.x && settled.y === n.y)))
    setSettled(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(body);
  const start = useRef<{ px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const pos = drag ?? settled ?? { x: n.x, y: n.y };
  const tilt = Math.round(n.rotation * 0.35 * 10) / 10;
  const color = (NOTE_COLORS as readonly string[]).includes(n.color)
    ? (n.color as NoteColor)
    : "yellow";

  // Element, not HTMLElement: a click usually starts on a button's SVG icon.
  const isControl = (target: EventTarget) =>
    target instanceof Element && !!target.closest("button, a, textarea, input");
  // Its menu lives in a portal, yet React bubbles its events here: never a drag or a nudge from it.
  const fromElsewhere = (e: React.SyntheticEvent) => !(e.target instanceof Node && e.currentTarget.contains(e.target));

  const saveNote = () => {
    setEditing(false);
    if (text !== body && (!(isNote || todo) || text.trim())) onNote(text.trim());
  };

  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={`${todo ? t("views.board.postit.todoLabel") : isNote && n.issueKey ? t("views.board.postit.noteOn", { key: n.issueKey }) : t("views.board.postit.label", { name: n.issueKey ?? t("views.board.postit.free") })}${body ? `: ${body}` : ""}`}
      data-postit
      {...surface("note")}
      data-dragging={drag ? "" : undefined}
      className={cn(
        "note-shadow absolute left-0 top-0 touch-none select-none rounded-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2",
        drag ? "cursor-grabbing" : !editing && "cursor-grab"
      )}
      style={{
        width: NOTE_SIZE,
        height: NOTE_SIZE,
        zIndex: n.z,
        transform: `translate3d(${pos.x}px, ${pos.y}px, 0) rotate(${tilt}deg)`,
      }}
      onPointerDown={e => {
        if (fromElsewhere(e) || editing || e.button !== 0 || isControl(e.target)) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { px: e.clientX, py: e.clientY, x: n.x, y: n.y, moved: false };
      }}
      onPointerMove={e => {
        const s = start.current;
        if (!s) return;
        const dx = (e.clientX - s.px) / zoom;
        const dy = (e.clientY - s.py) / zoom;
        if (!s.moved && Math.hypot(dx, dy) < 3) return;
        if (!s.moved) onFront();
        s.moved = true;
        const p = clampToCanvas(s.x + dx, s.y + dy);
        setDrag(p);
        onDrag?.(p);
      }}
      onPointerUp={e => {
        const s = start.current;
        start.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        if (s?.moved && drag) {
          setSettled({ ...drag, from: { x: n.x, y: n.y } });
          onMove(drag.x, drag.y);
        }
        setDrag(null);
        onDrag?.(null);
      }}
      onDoubleClick={e => {
        if (fromElsewhere(e) || readOnly || isControl(e.target)) return;
        setText(body);
        setEditing(true);
      }}
      onKeyDown={e => {
        if (editing || e.target !== e.currentTarget) return;
        const step = e.shiftKey ? 50 : 10;
        const moves: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        const m = moves[e.key];
        if (m) {
          e.preventDefault();
          onNudge(m[0], m[1]);
        } else if (e.key === "o" && n.issueKey) {
          e.preventDefault();
          onOpen();
        } else if (readOnly) {
          // Nothing written on it, nothing taken off: the tracker's.
        } else if (e.key === "Enter") {
          e.preventDefault();
          setText(body);
          setEditing(true);
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          onRemove();
        }
      }}
    >
      {isNote ? <span className="note-pin" aria-hidden /> : <span {...surface("glass")} className="note-tape" data-tone={TONE[color]} aria-hidden />}
      <div className="note-paper grain flex h-full flex-col overflow-hidden rounded-sm">
        <div className="flex min-h-0 flex-1 flex-col gap-1 px-3 pb-2 pt-4">
          {todo ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="text-overline uppercase opacity-70">{t("views.board.postit.todo")}</span>
              {todo.priority === 1 && <Flag className="h-3 w-3 shrink-0 text-primary-strong" aria-label={t("views.todos.priority")} />}
              {todo.issueKey && (
                <Link
                  to={issuePath({ key: todo.issueKey, connectionId: todo.connectionId })}
                  className="ml-auto truncate text-overline uppercase underline-offset-2 hover:underline"
                >
                  {todo.issueKey}
                </Link>
              )}
            </div>
          ) : isNote && n.issueKey ? (
            <div className="flex min-w-0 items-center gap-1.5 pt-1">
              <Link
                to={issuePath({ key: n.issueKey, connectionId: n.connectionId })}
                className="truncate text-overline uppercase underline-offset-2 hover:underline"
              >
                {n.issueKey}
              </Link>
              <Lock className="h-3 w-3 shrink-0 opacity-60" aria-label={t("views.board.postit.privateNote")} />
            </div>
          ) : n.issueKey ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <ProjectAvatar project={projectOf(n.issueKey)} size="xs" icon={false} />
              <Link
                to={issuePath({ key: n.issueKey, connectionId: n.connectionId })}
                className="truncate text-overline uppercase underline-offset-2 hover:underline"
              >
                {n.issueKey}
              </Link>
            </div>
          ) : (
            <span className="text-overline uppercase opacity-70">{t("views.board.postit.reminder")}</span>
          )}
          {editing ? (
            <textarea
              autoFocus
              value={text}
              maxLength={isNote ? 5000 : 500}
              onChange={e => setText(e.target.value)}
              onBlur={saveNote}
              onKeyDown={e => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setText(body);
                  setEditing(false);
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  saveNote();
                }
              }}
              aria-label={t("views.board.postit.noteLabel")}
              placeholder={t("views.board.postit.notePlaceholder")}
              className="min-h-0 flex-1 resize-none rounded-sm bg-card/50 p-1 text-body-sm leading-snug text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          ) : todo ? (
            <div className="flex min-h-0 items-start gap-2">
              <Checkbox
                className="mt-0.5"
                checked={todo.done}
                disabled={readOnly || !onTodoTick}
                aria-label={t(todo.done ? "views.todos.untick" : "views.todos.tick", { text: todo.text })}
                onCheckedChange={v => onTodoTick?.(v === true)}
              />
              <div className="grid min-w-0 gap-1">
                <p className={cn("line-clamp-4 whitespace-pre-line break-words font-display text-body font-semibold leading-snug", todo.done && "line-through opacity-60")}>{todo.text}</p>
                <p className="flex flex-wrap gap-x-2 text-2xs opacity-70">
                  {todo.dueOn && <span className={cn(!todo.done && todo.dueOn < dayKey(today) && "text-danger")}>{dayLabel(todo.dueOn, today)}</span>}
                  {steps(todo.steps)}
                </p>
              </div>
            </div>
          ) : isNote ? (
            <p className="line-clamp-6 whitespace-pre-line break-words text-body-sm leading-snug">{body}</p>
          ) : n.issueKey ? (
            <>
              {n.summary && (
                <p className="line-clamp-3 font-display text-body font-semibold leading-snug">
                  {n.summary}
                </p>
              )}
              {n.note && (
                <p className="line-clamp-2 whitespace-pre-line break-words text-body-sm leading-snug opacity-80">
                  – {n.note}
                </p>
              )}
            </>
          ) : (
            <p
              className={cn(
                "line-clamp-5 whitespace-pre-line break-words font-display text-body font-semibold leading-snug",
                !n.note && "font-normal opacity-55"
              )}
            >
              {n.note || t("views.board.postit.empty")}
            </p>
          )}
        </div>
        {/* Always there, quiet: tone, status, make an issue, unpin (the status alone where it is read-only). */}
        {/* The paper clips: its foot keeps room for the tape dots' shadows (the Shadow mod's reach). */}
        <div className="flex shrink-0 items-center gap-1 border-t border-foreground/5 pb-[max(0.375rem,var(--surface-reach-b,0px))] pl-[max(0.625rem,var(--surface-reach-l,0px))] pr-[max(0.625rem,var(--surface-reach-r,0px))] pt-1.5">
          {isNote && n.noteCreatedAt && (
            <span className="truncate text-2xs opacity-70">{formatDate(new Date(n.noteCreatedAt), "short")}</span>
          )}
          {!isNote && TAPE_ORDER.map((c, i) => (
            <button
              key={c}
              type="button"
              aria-label={t("views.board.postit.tape", { n: i + 1 })}
              aria-pressed={c === color}
              {...surface("chip")}
              onClick={() => onColor(c)}
              className={cn(
                "h-3 w-3 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                c === color && "ring-1 ring-foreground/50 ring-offset-1 ring-offset-transparent"
              )}
              style={{ background: tape(c) }}
            />
          ))}
          {!isNote && n.status && (
            <span className="ml-1.5 truncate text-2xs font-normal opacity-70">{n.status}</span>
          )}
          <span className="ml-auto flex items-center">
            {!readOnly && !n.issueKey && !todo && (
              <button
                type="button"
                aria-label={t("views.board.postit.createIssueLabel")}
                title={t("views.board.postit.createIssue")}
                onClick={onCreateIssue}
                className="rounded p-0.5 opacity-60 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <FilePlus2 className="h-3.5 w-3.5" />
              </button>
            )}
            {/* Move, copy, unpin: one small menu (read-only, a copy onto a board pinned by hand only). */}
            {(!readOnly || (n.issueKey && boards.length > 0)) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("views.board.postit.actions", { name: n.issueKey ?? t("views.board.postit.free") })}
                    title={t("views.board.postit.actionsTitle")}
                    className="rounded p-0.5 opacity-60 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:opacity-100"
                  >
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" onCloseAutoFocus={e => e.preventDefault()}>
                  {!readOnly && (
                    <BoardsSub label={t("views.board.postit.moveTo")} icon={<MoveRight className="h-4 w-4" aria-hidden />} boards={boards} onPick={id => onCopy?.(id, true)} />
                  )}
                  <BoardsSub
                    label={t(readOnly ? "views.board.postit.copyFollowed" : "views.board.postit.copyTo")}
                    icon={<Copy className="h-4 w-4" aria-hidden />}
                    boards={boards}
                    onPick={id => onCopy?.(id, false)}
                  />
                  {!readOnly && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={onRemove} aria-label={t(isNote ? "views.board.postit.unhangLabel" : "views.board.postit.unpinLabel")}>
                        <X className="h-4 w-4" aria-hidden />
                        {t("views.board.postit.unpin")}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/** A TODO's steps as "2/5", none when it has none. */
function steps(raw: string) {
  const all = parseSteps(raw);
  return all.length > 0 ? <span className="tabular">{t("views.board.postit.steps", { done: all.filter(s => s.done).length, total: all.length })}</span> : null;
}

/** The other boards, as a submenu (disabled, with a hint, when there are none). */
function BoardsSub({ label, icon, boards, onPick }: { label: string; icon: React.ReactNode; boards: { id: number; name: string }[]; onPick: (id: number) => void }) {
  if (boards.length === 0) {
    return (
      <DropdownMenuItem disabled>
        {icon}
        {label}
        <span className="ml-auto pl-2 text-caption text-muted-foreground">{t("views.board.postit.noOtherBoard")}</span>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {icon}
        {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {boards.map(b => (
          <DropdownMenuItem key={b.id} onSelect={() => onPick(b.id)}>
            <span className="truncate">{b.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
