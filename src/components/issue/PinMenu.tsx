import { Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePinIssue, useUnpinIssue } from "@/hooks/usePinIssue";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

type Board = { id: number; name: string; noteId: number | null };

/** Pin an issue on a board, or unpin it from one where it is. */
function usePinToggle(issueKey: string, connectionId?: number) {
  const pin = usePinIssue();
  const unpin = useUnpinIssue();
  return (b: Board) => (b.noteId === null ? pin(issueKey, connectionId, b.id) : unpin(issueKey, connectionId, b));
}

/** Where the issue is pinned, read while asked (a menu open, the issue page shown). */
const useWhere = (issueKey: string, connectionId?: number) => trpc.pinboard.where.useQuery({ issueKey, connectionId });

/** The boards with a check on the ones that hold the issue; a click pins or unpins. */
function BoardChecks({ boards, hiddenByBucket, toggle }: { boards: Board[]; hiddenByBucket: boolean; toggle: (b: Board) => void }) {
  return (
    <>
      <DropdownMenuLabel className="text-caption font-normal text-muted-foreground">
        {hiddenByBucket ? t("ui.pin.hiddenByBucket") : t("ui.pin.boards")}
      </DropdownMenuLabel>
      {boards.map(b => (
        <DropdownMenuCheckboxItem key={b.id} checked={b.noteId !== null} onSelect={() => toggle(b)}>
          {b.name}
        </DropdownMenuCheckboxItem>
      ))}
    </>
  );
}

/**
 * The pin entry of an issue's menu (mounted while the menu is open): with one
 * board, one item that pins or unpins; with more, a submenu of the boards.
 */
export function PinMenuItems({ issueKey, connectionId, label }: { issueKey: string; connectionId?: number; label: string }) {
  const where = useWhere(issueKey, connectionId);
  const toggle = usePinToggle(issueKey, connectionId);
  const pin = usePinIssue();
  const boards = where.data?.boards;
  if (!boards || boards.length <= 1) {
    const only = boards?.[0];
    return (
      <DropdownMenuItem onSelect={() => void (only ? toggle(only) : pin(issueKey, connectionId))}>
        <Pin className="h-4 w-4" /> {only?.noteId != null ? t("ui.pin.unpin") : label}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Pin className="h-4 w-4" /> {label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
        <BoardChecks boards={boards} hiddenByBucket={where.data?.hiddenByBucket ?? false} toggle={b => void toggle(b)} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** The issue page's pin button: one board, a click pins or unpins; more, the list of boards. */
export function PinButton({ issueKey, connectionId }: { issueKey: string; connectionId?: number }) {
  const where = useWhere(issueKey, connectionId);
  const toggle = usePinToggle(issueKey, connectionId);
  const pin = usePinIssue();
  const boards = where.data?.boards ?? [];
  const pinned = boards.some(b => b.noteId !== null);
  const label = pinned ? t("ui.pin.pinnedOn", { count: boards.filter(b => b.noteId !== null).length }) : t("pages.issueDetail.pin");
  const icon = <Pin className={cn("h-4 w-4 -rotate-12", pinned && "fill-current")} />;
  // Until it is known where the issue is (and on how many boards it could go), a click would pin
  // straight to the default board instead of offering the choice: the button waits.
  if (!where.data) {
    return (
      <Button variant="ghost" size="icon" aria-label={t("pages.issueDetail.pin")} title={t("pages.issueDetail.pin")} disabled>
        {icon}
      </Button>
    );
  }
  if (boards.length <= 1) {
    const only = boards[0];
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label={only?.noteId != null ? t("ui.pin.unpin") : t("pages.issueDetail.pin")}
        aria-pressed={pinned}
        title={only?.noteId != null ? t("ui.pin.unpin") : t("pages.issueDetail.pin")}
        onClick={() => void (only ? toggle(only) : pin(issueKey, connectionId))}
      >
        {icon}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} aria-pressed={pinned} title={label}>
          {icon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
        <BoardChecks boards={boards} hiddenByBucket={where.data?.hiddenByBucket ?? false} toggle={b => void toggle(b)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
