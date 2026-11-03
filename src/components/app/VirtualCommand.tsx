import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { filterSections, moveActive, type CommandOption, type CommandSection, type Move } from "@/lib/commandRows";

/** Where the list sits: a dialog of its own (Quick start, ⌘K) or a popover beside a field (the issue pickers). */
export type CommandSize = "dialog" | "popover";

/**
 * A searchable list that draws only the rows in view: thousands of issues open and
 * filter at once (cmdk mounted, scored and moved every row on each key). Results,
 * order and keys as cmdk 1.1.1 (src/lib/commandRows.ts): ↑↓, ⌘↑↓ first/last,
 * Alt↑↓ by section, Home/End, Ctrl+N/J/P/K, PageUp/PageDown, Enter; ⌘/Ctrl+Enter is
 * `alt`. ARIA 1.2 combobox: the input keeps the focus, the active option is its
 * `aria-activedescendant` (always drawn), each option says its place in the whole
 * list and its section. Mount it only while open.
 */
export function VirtualCommand({
  sections,
  query,
  onQueryChange,
  onSelect,
  renderOption,
  placeholder,
  label,
  empty,
  size,
  footer,
  inputRef,
  autoFocus = false,
}: {
  sections: readonly CommandSection[];
  query: string;
  onQueryChange: (query: string) => void;
  /** The active option chosen (`null`: none, e.g. ⌘Enter on a typed key); `alt`: with ⌘/Ctrl. */
  onSelect: (id: string | null, how: { alt: boolean }) => void;
  renderOption: (option: CommandOption) => ReactNode;
  placeholder: string;
  /** The list's name for a screen reader */
  label: string;
  /** Said when the search finds nothing; undefined: nothing said (something else is offered). */
  empty?: ReactNode;
  size: CommandSize;
  footer?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  /** Focus the search at once (a popover; a dialog focuses its first field itself). */
  autoFocus?: boolean;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const filtered = useMemo(() => filterSections(sections, query), [sections, query]);
  // The first option after every new search, as cmdk.
  const [active, setActive] = useState({ query, n: 0 });
  const current = active.query !== query ? 0 : Math.min(active.n, filtered.options - 1);
  if (active.query !== query) setActive({ query, n: 0 });
  const activeRow = current >= 0 ? filtered.rowOf[current] : -1;

  const scroller = useRef<HTMLDivElement>(null);
  const dialog = size === "dialog";
  // TanStack Virtual hands back new functions on every render: the compiler leaves this component
  // unmemoized, which it is anyway (it draws again on every scroll step).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: filtered.rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: i => (filtered.rows[i]?.kind === "heading" ? 28 : dialog ? 44 : 32),
    overscan: 8,
    // The active option is always drawn: the input's aria-activedescendant names it.
    rangeExtractor: (range: Range) => {
      const rows = defaultRangeExtractor(range);
      return activeRow >= 0 && !rows.includes(activeRow) ? [...rows, activeRow].sort((a, b) => a - b) : rows;
    },
  });

  const optionId = (n: number) => `${id}-o${n}`;
  const sectionLabelId = (sectionId: string) => `${id}-s-${sectionId}`;

  const go = (move: Move) => {
    const pageSize = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 300) / (dialog ? 44 : 32)) - 1);
    const n = moveActive(current, move, filtered, pageSize);
    if (n < 0) return;
    setActive({ query, n });
    const row = filtered.rowOf[n];
    // The first option of a section brings its heading into view too.
    const heading = row > 0 && filtered.rows[row - 1]?.kind === "heading" ? row - 1 : row;
    virtualizer.scrollToIndex(heading, { align: "auto" });
    if (heading !== row) virtualizer.scrollToIndex(row, { align: "auto" });
    // A long jump is placed from estimated row heights: once drawn and measured, the option itself
    // comes into view (as cmdk did), whatever the density made its height.
    requestAnimationFrame(() => document.getElementById(optionId(n))?.scrollIntoView({ block: "nearest" }));
  };

  const choose = (n: number, alt: boolean) => {
    const row = n >= 0 ? filtered.rows[filtered.rowOf[n]] : undefined;
    onSelect(row?.kind === "option" ? row.option.id : null, { alt });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing || e.keyCode === 229) return;
    const vim = e.ctrlKey && !e.metaKey && !e.altKey;
    const move: Move | null =
      e.key === "ArrowDown" ? (e.metaKey ? "last" : e.altKey ? "nextSection" : "next")
      : e.key === "ArrowUp" ? (e.metaKey ? "first" : e.altKey ? "prevSection" : "prev")
      : e.key === "Home" ? "first"
      : e.key === "End" ? "last"
      : e.key === "PageDown" ? "pageDown"
      : e.key === "PageUp" ? "pageUp"
      : vim && (e.key === "n" || e.key === "j") ? "next"
      : vim && (e.key === "p" || e.key === "k") ? "prev"
      : null;
    if (move) {
      e.preventDefault();
      go(move);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      choose(current, e.metaKey || e.ctrlKey);
    }
  };

  // Each section's name, always in the page (its heading row may be out of view): what an option is described by.
  const sectionNames = useMemo(
    () => [...new Map(filtered.rows.flatMap(r => (r.kind === "heading" && r.section.heading ? [[r.section.id, r.section.heading] as const] : []))).entries()],
    [filtered.rows]
  );

  return (
    <div className="flex min-h-0 flex-col">
      <div data-slot="command-input-wrapper" className={cn("flex items-center gap-2 border-b px-3", dialog ? "h-12" : "h-9")}>
        <SearchIcon className={cn("shrink-0 opacity-50", dialog ? "size-5" : "size-4")} aria-hidden />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          aria-label={label}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          type="text"
          value={query}
          placeholder={placeholder}
          onChange={e => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          className={cn(
            "flex w-full rounded-md bg-transparent py-3 text-field outline-none placeholder:text-muted-foreground md:text-body-sm disabled:cursor-not-allowed disabled:opacity-50",
            dialog ? "h-12" : "h-10"
          )}
        />
      </div>
      <p role="status" className="sr-only">
        {query ? t("ui.command.results", { count: filtered.counted }) : ""}
      </p>
      {sectionNames.map(([sectionId, name]) => (
        <span key={sectionId} id={sectionLabelId(sectionId)} hidden>
          {name}
        </span>
      ))}
      <div ref={scroller} id={listId} role="listbox" aria-label={label} tabIndex={-1} className="max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto">
        {filtered.counted === 0 && empty !== undefined && <div className="py-6 text-center text-body-sm">{empty}</div>}
        <div role="presentation" className={cn("relative w-full", dialog ? "px-2" : "px-1")} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map(item => {
            const row = filtered.rows[item.index];
            const place = { transform: `translateY(${item.start}px)` };
            if (row.kind === "heading")
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  role="presentation"
                  aria-hidden
                  style={place}
                  className={cn("absolute inset-x-0 px-2 py-1.5 text-overline uppercase text-muted-foreground", dialog && "px-4 font-medium")}
                >
                  {row.section.heading}
                </div>
              );
            const selected = row.n === current;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                role="presentation"
                style={place}
                className={cn("absolute inset-x-0", dialog ? "px-2" : "px-1")}
              >
                <div
                  id={optionId(row.n)}
                  role="option"
                  aria-selected={selected}
                  aria-setsize={filtered.options}
                  aria-posinset={row.n + 1}
                  aria-describedby={row.section.heading ? sectionLabelId(row.section.id) : undefined}
                  data-selected={selected ? "true" : undefined}
                  onPointerMove={() => !selected && setActive({ query, n: row.n })}
                  onClick={() => choose(row.n, false)}
                  className={cn(
                    "relative flex cursor-default items-center gap-2 rounded-sm px-2 text-body-sm outline-none select-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='text-'])]:text-muted-foreground",
                    dialog ? "py-3 [&_svg]:h-5 [&_svg]:w-5" : "py-1.5 [&_svg:not([class*='size-'])]:size-4"
                  )}
                >
                  {renderOption(row.option)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {footer}
    </div>
  );
}
