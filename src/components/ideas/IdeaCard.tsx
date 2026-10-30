import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../api/router";
import { MoreHorizontal } from "lucide-react";
import { IDEA_STATES, type IdeaState } from "@contracts/ideas";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/app/Chip";
import { surface } from "@/components/app/surface";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

export type Idea = inferRouterOutputs<AppRouter>["ideas"]["list"][number];

/** An idea on the board or in the list: its title opens it, it drags to another column, and its menu (or Alt+←/→) moves it by keyboard. */
export function IdeaCard({ idea, onOpen, onMove, onDelete }: { idea: Idea; onOpen: () => void; onMove: (to: IdeaState) => void; onDelete: () => void }) {
  const openQuestions = idea.questions.filter(q => q.answer.trim() === "").length;
  const at = IDEA_STATES.indexOf(idea.state);
  return (
    <li
      {...surface("card")}
      aria-label={idea.title}
      draggable
      tabIndex={0}
      data-idea={idea.id}
      className="rounded-lg border bg-card px-3 py-2 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onDragStart={e => {
        e.dataTransfer.setData("application/x-idea", String(idea.id));
        e.dataTransfer.effectAllowed = "move";
      }}
      onKeyDown={e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter") onOpen();
        // Alt+←/→: the column before or after.
        else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          const to = IDEA_STATES[at + (e.key === "ArrowLeft" ? -1 : 1)];
          if (to) {
            e.preventDefault();
            onMove(to);
          }
        }
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
        <button type="button" className="line-clamp-2 text-left text-body-sm font-medium [overflow-wrap:anywhere] hover:underline" aria-label={t("pages.ideas.open", { title: idea.title })} onClick={onOpen}>
          {idea.title}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t("pages.ideas.more", { title: idea.title })}>
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t("pages.ideas.moveTo")}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {IDEA_STATES.filter(s => s !== idea.state).map(s => (
                  <DropdownMenuItem key={s} onSelect={() => onMove(s)}>
                    {t(`pages.ideas.state.${s}`)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={onDelete}>{t("pages.ideas.delete")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {(idea.container || idea.route || openQuestions > 0 || idea.source || idea.promoted) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {idea.container && <Chip>{idea.container.key}</Chip>}
          {idea.route && <Chip tone="info">{t(`pages.ideas.route.${idea.route}`)}</Chip>}
          {openQuestions > 0 && <Chip tone="warning">{t("pages.ideas.openQuestions", { count: openQuestions })}</Chip>}
          {idea.source && <Chip>{idea.source.key}</Chip>}
          {idea.promoted &&
            (idea.promoted.gone ? (
              <Chip>
                <s>{idea.promoted.key}</s>
                <span className="sr-only">{t("pages.ideas.gone", { key: idea.promoted.key })}</span>
              </Chip>
            ) : (
              <Chip tone="success">{t("pages.ideas.became", { key: idea.promoted.key })}</Chip>
            ))}
        </div>
      )}
    </li>
  );
}
