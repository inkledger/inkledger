import { useState } from "react";
import { Tag } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { errorText } from "@/lib/errorText";
import { t } from "@/i18n";

export type FollowedTag = { field: "label" | "component"; value: string };

/**
 * "Follow a tag": the labels and components of the user's open issues, most
 * used first, filtered as typed; the one chosen becomes a board that shows
 * the open issues carrying it, kept up to date by the tracker.
 */
export function FollowTagDialog({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (tag: FollowedTag) => void }) {
  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("views.board.pinboard.followTitle")}</DialogTitle>
          <DialogDescription>{t("views.board.pinboard.followHint")}</DialogDescription>
        </DialogHeader>
        {open && <TagList onPick={onPick} />}
      </DialogContent>
    </Dialog>
  );
}

function TagList({ onPick }: { onPick: (tag: FollowedTag) => void }) {
  const tags = trpc.pinboard.tags.useQuery();
  const [filter, setFilter] = useState("");
  const shown = (tags.data ?? []).filter(x => x.value.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <div className="grid gap-3">
      <Input
        autoFocus
        type="search"
        aria-label={t("views.board.pinboard.followFilter")}
        placeholder={t("views.board.pinboard.followFilter")}
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      <ul aria-label={t("views.board.pinboard.followTags")} className="grid max-h-80 gap-0.5 overflow-y-auto">
        {tags.error ? (
          <li className="px-2 py-1.5 text-body-sm text-danger">{errorText(tags.error)}</li>
        ) : tags.isPending ? (
          <li className="px-2 py-1.5 text-body-sm text-muted-foreground">{t("views.board.pinboard.searching")}</li>
        ) : shown.length === 0 ? (
          <li className="px-2 py-1.5 text-body-sm text-muted-foreground">{t("views.board.pinboard.followNone")}</li>
        ) : (
          shown.map(x => (
            <li key={`${x.field}:${x.value}`}>
              <button
                type="button"
                onClick={() => onPick({ field: x.field, value: x.value })}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{x.value}</span>
                <span className="shrink-0 text-caption text-muted-foreground">
                  {x.field === "component" ? t("views.board.pinboard.followComponent") : t("views.board.pinboard.followLabel")}
                </span>
                <span className="w-6 shrink-0 text-right text-caption text-muted-foreground tabular">{x.count}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
