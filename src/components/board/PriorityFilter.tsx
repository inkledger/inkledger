import { Flag } from "lucide-react";
import { Dot } from "@/components/app/Chip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { levelKey, toneOfLevel } from "@/lib/jira";
import { cn } from "@/lib/utils";
import { PRIORITY_LEVELS } from "@contracts/query";
import { t } from "@/i18n";

const NAMES = ["highest", "high", "medium", "low", "lowest"] as const;
const levelName = (key: string) =>
  key === "none" ? t("pages.board.priorityNone") : t(`pages.board.priorityLevels.${NAMES[Number(key)]}`);

/**
 * Which priorities the board shows: several levels at once (the menu stays
 * open while they are ticked), each with how many cards it has here; none
 * ticked is every one.
 */
export function PriorityFilter({
  chosen,
  counts,
  onChange,
}: {
  chosen: Set<string>;
  /** Cards per level key in the current view (before this filter). */
  counts: Map<string, number>;
  onChange: (next: Set<string>) => void;
}) {
  const keys = [...PRIORITY_LEVELS.map(l => levelKey(l)), "none"];
  const toggle = (k: string) => {
    const next = new Set(chosen);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    onChange(next);
  };
  const label = chosen.size ? t("pages.board.priorityActive", { count: chosen.size }) : t("pages.board.priority");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          aria-label={chosen.size ? `${t("pages.board.priorityLabel")}: ${[...chosen].map(levelName).join(", ")}` : t("pages.board.priorityLabel")}
          className={cn(chosen.size > 0 && "border-primary-strong/40 bg-primary-soft text-primary-strong")}
        >
          <Flag className="h-4 w-4" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {keys.map(k => (
          <DropdownMenuCheckboxItem
            key={k}
            checked={chosen.has(k)}
            // Several at once: ticking one keeps the menu open.
            onSelect={e => {
              e.preventDefault();
              toggle(k);
            }}
          >
            <Dot tone={toneOfLevel(k === "none" ? null : Number(k))} />
            <span className="flex-1">{levelName(k)}</span>
            <span className="text-caption text-muted-foreground tabular">{counts.get(k) ?? 0}</span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={chosen.size === 0} onSelect={() => onChange(new Set())}>
          {t("pages.board.priorityAll")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
