import { useRef } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { Search, StickyNote } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { surface } from "@/components/app/surface";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { canShowPinboard, pinboardBoard, showPinboard } from "@/hooks/usePinboardPanel";
import { toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { formatQuery, parseQuery } from "@contracts/query";
import { t, useLocale } from "@/i18n";
import { showNewBoard } from "./followBoard";
import type { AppRouter } from "../../../api/router";

type Board = inferRouterOutputs<AppRouter>["pinboard"]["boards"][number];

type Field = "label" | "component";

/**
 * An issue's tags, one place for every kind the trackers have (labels,
 * components), grouped by kind. Each opens a menu: the pinboard that follows
 * it (made on the spot when there is none yet), or the issues that carry it.
 */
export function IssueTags({ labels, components, editor }: { labels: string[]; components: string[]; editor?: React.ReactNode }) {
  const groups = [
    { field: "label" as const, title: t("pages.issueDetail.tagLabels"), values: labels },
    { field: "component" as const, title: t("pages.issueDetail.tagComponents"), values: components },
  ].filter(g => g.values.length > 0);
  return (
    <span className="grid gap-1.5">
      {groups.length === 0 && "—"}
      {groups.map(g => (
        <span key={g.field} className="grid gap-1">
          {/* Each kind under its name: the trackers' words differ, the place is one. */}
          <span className="text-2xs text-muted-foreground">{g.title}</span>
          <span className="flex flex-wrap gap-1">
            {g.values.map(v => (
              <TagChip key={v} field={g.field} value={v} />
            ))}
          </span>
        </span>
      ))}
      {editor}
    </span>
  );
}

function TagChip({ field, value }: { field: Field; value: string }) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const lang = useLocale() === "it" ? "it" : "en";
  const boards = trpc.pinboard.boards.useQuery();
  const following = (boards.data ?? []).find(b => b.follow?.field === field && b.follow.value === value);
  const open = (id: number) => {
    pinboardBoard.set(id);
    if (canShowPinboard()) showPinboard();
  };
  // One board per tag: a second pick while the first is being made waits for it, never makes another.
  const creating = useRef(false);
  const follow = () => {
    if (following) return open(following.id);
    if (creating.current) return;
    creating.current = true;
    const name = value.slice(0, 60);
    void utils.client.pinboard.createBoard
      .mutate({ name, follow: { field, value } })
      .then(async ({ id }) => {
        pinboardBoard.set(id);
        // The menu says "Open" from now on: the board in the list at once (a load from before it dropped), then the list read again.
        await showNewBoard<Board>(
          {
            cancel: () => utils.pinboard.boards.cancel(),
            setData: update => utils.pinboard.boards.setData(undefined, update),
            invalidate: () => utils.pinboard.invalidate(),
          },
          { id, name, follow: { connectionId: null, field, value }, bucket: null, count: 0, group: "all", hidden: 0 },
        );
        toast.success(t("views.board.pinboard.created", { name: value }), {
          action: canShowPinboard() ? { label: t("ui.pin.open"), onClick: () => open(id) } : undefined,
        });
      }, toastError)
      .finally(() => {
        creating.current = false;
      });
  };
  const search = () => {
    const raw = `${field}:${JSON.stringify(value)}`;
    void navigate(`/issues?q=${encodeURIComponent(formatQuery(parseQuery(raw).expr, lang) || raw)}`);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          {...surface("chip")}
          aria-label={t(field === "component" ? "pages.issueDetail.tagComponentActions" : "pages.issueDetail.tagLabelActions", { value })}
          className="inline-flex max-w-full items-center rounded-md bg-muted px-1.5 py-0.5 text-caption text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate">{value}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel className="text-caption font-normal text-muted-foreground">
          {t(field === "component" ? "views.board.pinboard.followComponent" : "views.board.pinboard.followLabel")} «{value}»
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={follow}>
          <StickyNote className="h-4 w-4" aria-hidden />
          {following ? t("pages.issueDetail.tagOpenBoard", { name: following.name }) : t("pages.issueDetail.tagFollow")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={search}>
          <Search className="h-4 w-4" aria-hidden />
          {t("pages.issueDetail.tagSearch")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
