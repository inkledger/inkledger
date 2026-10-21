import { useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { ProjectAvatar } from "@/components/app/ProjectAvatar";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
}: {
  id?: string;
  issues: PickableIssue[];
  value: IssueRef | null;
  onChange: (pick: IssueRef) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Inside a Dialog the list must live in the dialog's DOM: its scroll lock
  // and focus trap only let wheel, clicks and focus through there.
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const toggle = (next: boolean) => {
    if (next) {
      setContainer(trigger.current?.closest<HTMLElement>("[role=dialog]") ?? null);
    }
    setOpen(next);
  };
  const connections = useConnections().data ?? [];
  const selected = value ? issues.find(i => sameIssue(i, value)) : undefined;
  // Keys on more than one connection get the connection's name as a suffix.
  const seen = new Set<string>();
  const clashing = new Set<string>();
  for (const i of issues) (seen.has(i.key) ? clashing : seen).add(i.key);
  const labelOf = (i: PickableIssue) =>
    clashing.has(i.key) ? connections.find(c => c.id === i.connectionId)?.name : undefined;
  const favorites = issues.filter(i => i.favorite === 1);
  const others = issues.filter(i => i.favorite !== 1);

  const item = (i: PickableIssue) => (
    <CommandItem
      key={`${i.connectionId ?? ""}:${i.key}`}
      value={`${i.key} ${i.summary} ${i.connectionId ?? ""}`}
      onSelect={() => {
        onChange({ key: i.key, connectionId: i.connectionId });
        setOpen(false);
      }}
      className="gap-2"
    >
      <ProjectAvatar project={projectOf(i.key)} size="xs" />
      <span className="shrink-0 font-semibold">{i.key}</span>
      <span className="truncate text-muted-foreground">{i.summary}</span>
      {labelOf(i) && <span className="shrink-0 text-caption text-muted-foreground">{labelOf(i)}</span>}
      {selected === i && <Check className="ml-auto h-4 w-4 shrink-0" />}
    </CommandItem>
  );

  return (
    <Popover open={open} onOpenChange={toggle}>
      <PopoverTrigger asChild>
        {/* surface: none — a sunk field: it never casts */}
        <button
          ref={trigger}
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "flex h-9 w-full min-w-0 items-center gap-2 rounded-md border border-input bg-transparent px-3 text-left text-body-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 dark:bg-input/30",
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
      <PopoverContent
        container={container}
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0"
      >
        <Command>
          <CommandInput autoFocus placeholder={placeholder} />
          <CommandList>
            <CommandEmpty>{t("ui.picker.empty")}</CommandEmpty>
            {favorites.length > 0 && (
              <CommandGroup heading={t("ui.picker.favorites")}>{favorites.map(item)}</CommandGroup>
            )}
            <CommandGroup heading={favorites.length > 0 ? t("ui.picker.others") : undefined}>
              {others.map(item)}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
