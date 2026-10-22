import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { surface } from "@/components/app/surface";
import { t } from "@/i18n";

type Found = { key: string; connectionId: number; summary: string; status: string };

/**
 * Pin fast: the issues found by the search language (any of the user's, done
 * or not), the ones already on the board checked; Enter or a click pins the
 * chosen one in the first free spot, the list stays for the next.
 */
export function PinSearch({
  onBoard,
  onPick,
  inputRef,
}: {
  /** The issues already on the board, as `connectionId:key`. */
  onBoard: Set<string>;
  onPick: (issue: Found) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [typed, setTyped] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const search = useDebouncedValue(typed.trim(), 200);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const found = trpc.issues.list.useQuery(
    { search, includeDone: true, includeUnassigned: true, pageSize: 8 },
    { enabled: search.length > 0, placeholderData: prev => prev, staleTime: 30_000 }
  );
  const items: Found[] = search ? (found.data?.issues ?? []) : [];
  const shown = open && search.length > 0;
  const at = Math.min(active, Math.max(0, items.length - 1));
  const pick = (i: Found | undefined) => {
    if (i) onPick(i);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(Math.min(Math.max(0, items.length - 1), Math.max(0, at + step)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(items[at]);
    } else if (e.key === "Escape" && (typed || shown)) {
      // Used here: the pinboard around stays open.
      e.preventDefault();
      if (shown) setOpen(false);
      else setTyped("");
    }
  };
  return (
    <div
      ref={box}
      className="relative shrink-0"
      onBlur={e => {
        if (!box.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden />
      <Input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && items[at] ? `${listId}-${at}` : undefined}
        aria-label={t("views.board.pinboard.searchLabel")}
        placeholder={t("views.board.pinboard.searchPlaceholder")}
        className="h-8 pl-8 text-body-sm"
        value={typed}
        onChange={e => {
          setTyped(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("views.board.pinboard.searchResults")}
          {...surface("menu")}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground"
        >
          {items.length === 0 ? (
            <li className="px-2 py-1.5 text-body-sm text-muted-foreground">
              {found.isFetching ? t("views.board.pinboard.searching") : t("views.board.pinboard.searchNone")}
            </li>
          ) : (
            items.map((i, n) => {
              const here = onBoard.has(`${i.connectionId}:${i.key}`);
              return (
                <li
                  key={`${i.connectionId}:${i.key}`}
                  id={`${listId}-${n}`}
                  role="option"
                  aria-selected={n === at}
                  // Keeps the focus in the field: the next Enter pins the next one.
                  onMouseDown={e => e.preventDefault()}
                  onMouseEnter={() => setActive(n)}
                  onClick={() => pick(i)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-body-sm",
                    n === at && "bg-accent text-accent-foreground"
                  )}
                >
                  <span className="shrink-0 font-medium tabular">{i.key}</span>
                  <span className="min-w-0 flex-1 truncate">{i.summary}</span>
                  <span className="shrink-0 text-caption text-muted-foreground">{i.status}</span>
                  {here ? (
                    <Check className="h-4 w-4 shrink-0 text-primary-strong" aria-label={t("views.board.pinboard.searchOnBoard")} />
                  ) : (
                    <span className="h-4 w-4 shrink-0" aria-hidden />
                  )}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
