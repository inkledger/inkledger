import { useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import { VirtualCommand } from "@/components/app/VirtualCommand";
import type { CommandSection } from "@/lib/commandRows";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { projectOf } from "@/lib/projectColors";
import { cn } from "@/lib/utils";
import { useConnections } from "@/hooks/useConnections";
import { t } from "@/i18n";

export type PickableIssue = {
  key: string;
  /** The issue's connection: a key is unique only per connection. */
  connectionId?: number;
  summary: string;
  favorite: number;
};

/** What the picker holds and reports: key plus connection. */
export type IssueRef = { key: string; connectionId?: number };

const sameIssue = (i: IssueRef, ref: IssueRef) =>
  i.key === ref.key && i.connectionId === ref.connectionId;

/**
 * Themed issue combobox (key or title search), favorites first. Replaces the
 * native datalist, whose popup ignores the app theme.
 */
export function IssuePicker({
  id,
  issues,
  value,
  onChange,
  placeholder = t("ui.picker.placeholder"),
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  id?: string;
  issues: PickableIssue[];
  value: IssueRef | null;
  onChange: (pick: IssueRef) => void;
  placeholder?: string;
  /** Open at once (asked for from a menu). */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A trigger of its own (a chip) instead of the field. */
  children?: React.ReactElement;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const trigger = useRef<HTMLButtonElement>(null);
  // Inside a Dialog the list must live in the dialog's DOM: its scroll lock
  // and focus trap only let wheel, clicks and focus through there.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const toggle = (next: boolean) => {
    if (next) {
      setContainer(trigger.current?.closest<HTMLElement>("[role=dialog]") ?? null);
    }
    setOpen(next);
    onOpenChange?.(next);
  };
  const connections = useConnections().data ?? [];
  const selected = value ? issues.find(i => sameIssue(i, value)) : undefined;
  // Keys on more than one connection get the connection's name as a suffix.
  const seen = new Set<string>();
  const clashing = new Set<string>();
  for (const i of issues) (seen.has(i.key) ? clashing : seen).add(i.key);
  const labelOf = (i: PickableIssue) =>
    clashing.has(i.key) ? connections.find(c => c.id === i.connectionId)?.name : undefined;

  return (
    <Popover open={open} onOpenChange={toggle}>
      {children ? (
        <PopoverTrigger asChild ref={trigger}>
          {children}
        </PopoverTrigger>
      ) : (
        <PopoverTrigger asChild>
          {/* surface: none — a sunk field: it never casts */}
          <button
            ref={trigger}
            id={id}
            type="button"
            role="combobox"
            aria-expanded={open}
            className={cn(
              "flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-3 text-left text-body-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring dark:bg-input/30",
              !selected && "text-muted-foreground"
            )}
          >
            {selected ? (
              <>
                <ProjectAvatar project={projectOf(selected.key)} size="xs" />
                <span className="shrink-0 font-semibold text-foreground">
                  {selected.key}
                </span>
                <span className="truncate text-muted-foreground">
                  {selected.summary}
                </span>
                {labelOf(selected) && (
                  <span className="shrink-0 text-caption text-muted-foreground">
                    {labelOf(selected)}
                  </span>
                )}
              </>
            ) : (
              <span className="truncate">{placeholder}</span>
            )}
            <ChevronsUpDown
              className="ml-auto h-4 w-4 shrink-0 opacity-50"
              aria-hidden
            />
          </button>
        </PopoverTrigger>
      )}
      <PopoverContent
        container={container}
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0"
      >
        {/* Drawn only while open, only the rows in view: a page may hold many pickers (one per TODO row). */}
        <PickerList
          issues={issues}
          selected={selected}
          labelOf={labelOf}
          placeholder={placeholder}
          onPick={i => {
            onChange({ key: i.key, connectionId: i.connectionId });
            toggle(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

const idOf = (i: PickableIssue) => `${i.connectionId ?? ""}:${i.key}`;

/** The open picker's list: its own search (empty on every opening), favourites first. */
function PickerList({
  issues,
  selected,
  labelOf,
  placeholder,
  onPick,
}: {
  issues: PickableIssue[];
  selected: PickableIssue | undefined;
  labelOf: (i: PickableIssue) => string | undefined;
  placeholder: string;
  onPick: (i: PickableIssue) => void;
}) {
  const [query, setQuery] = useState("");
  const byId = useMemo(() => new Map(issues.map(i => [idOf(i), i])), [issues]);
  const sections = useMemo((): CommandSection[] => {
    const option = (i: PickableIssue) => ({ id: idOf(i), search: `${i.key} ${i.summary} ${i.connectionId ?? ""}` });
    const favorites = issues.filter(i => i.favorite === 1).map(option);
    const others = issues.filter(i => i.favorite !== 1).map(option);
    return [
      { id: "favorites", heading: t("ui.picker.favorites"), options: favorites },
      { id: "others", heading: favorites.length > 0 ? t("ui.picker.others") : undefined, options: others },
    ];
  }, [issues]);
  return (
    <VirtualCommand
      size="popover"
      autoFocus
      sections={sections}
      query={query}
      onQueryChange={setQuery}
      placeholder={placeholder}
      label={placeholder}
      empty={t("ui.picker.empty")}
      onSelect={id => {
        const i = id ? byId.get(id) : undefined;
        if (i) onPick(i);
      }}
      renderOption={o => {
        const i = byId.get(o.id);
        if (!i) return null;
        return (
          <>
            <ProjectAvatar project={projectOf(i.key)} size="xs" />
            <span className="shrink-0 font-semibold">{i.key}</span>
            <span className="truncate text-muted-foreground">{i.summary}</span>
            {labelOf(i) && <span className="shrink-0 text-caption text-muted-foreground">{labelOf(i)}</span>}
            {selected === i && <Check className="ml-auto h-4 w-4 shrink-0" />}
          </>
        );
      }}
    />
  );
}
