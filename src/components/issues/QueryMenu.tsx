import { useState } from "react";
import { Bookmark, History, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { formatQuery, parseQuery } from "@contracts/query";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t, useLocale } from "@/i18n";

/** A kept query (English) in the user's language. */
const shown = (query: string, lang: "en" | "it") => formatQuery(parseQuery(query).expr, lang) || query;

/** Recent and saved searches next to a search box: pick one, save the current one. */
export function QueryMenu({ value, onPick }: { value: string; onPick: (query: string) => void }) {
  const utils = trpc.useUtils();
  const lang = useLocale() === "it" ? "it" : "en";
  const kept = trpc.queries.list.useQuery(undefined, { staleTime: 60_000 });
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const done = () => void utils.queries.list.invalidate();
  const save = trpc.queries.save.useMutation({
    onSuccess: () => {
      done();
      toast.success(t("views.issues.queries.saved", { name }));
      setSaving(false);
      setName("");
    },
    onError: e => toast.error(e.message),
  });
  const remove = trpc.queries.delete.useMutation({ onSuccess: done, onError: e => toast.error(e.message) });
  const clear = trpc.queries.clearRecent.useMutation({ onSuccess: done });
  const saved = kept.data?.saved ?? [];
  const recent = kept.data?.recent ?? [];
  const current = value.trim();
  return (
    <div className="flex items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t("views.issues.queries.menu")} disabled={saved.length === 0 && recent.length === 0}>
            <History />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {saved.length > 0 && <DropdownMenuLabel>{t("views.issues.queries.savedHeading")}</DropdownMenuLabel>}
          {saved.map(s => (
            <DropdownMenuItem key={s.id} onSelect={() => onPick(shown(s.query, lang))} className="gap-2">
              <Bookmark className="h-4 w-4" />
              <span className="font-medium">{s.name}</span>
              <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{shown(s.query, lang)}</span>
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label={t("views.issues.queries.delete", { name: s.name })}
                onClick={e => {
                  e.stopPropagation();
                  e.preventDefault();
                  remove.mutate({ id: s.id });
                }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuItem>
          ))}
          {saved.length > 0 && recent.length > 0 && <DropdownMenuSeparator />}
          {recent.length > 0 && <DropdownMenuLabel>{t("views.issues.queries.recentHeading")}</DropdownMenuLabel>}
          {recent.map(q => (
            <DropdownMenuItem key={q} onSelect={() => onPick(shown(q, lang))}>
              <History className="h-4 w-4" />
              <span className="truncate">{shown(q, lang)}</span>
            </DropdownMenuItem>
          ))}
          {recent.length > 0 && (
            <DropdownMenuItem onSelect={() => clear.mutate()} className="text-muted-foreground">
              <Trash2 className="h-4 w-4" />
              {t("views.issues.queries.clearRecent")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover open={saving} onOpenChange={setSaving}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={t("views.issues.queries.save")} disabled={current.length === 0}>
            <Bookmark />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <form
            className="grid gap-2"
            onSubmit={e => {
              e.preventDefault();
              save.mutate({ name, query: current });
            }}
          >
            <p className="truncate text-caption text-muted-foreground">{current}</p>
            <Input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={t("views.issues.queries.namePlaceholder")} aria-label={t("views.issues.queries.name")} required />
            <Button type="submit" size="sm" disabled={save.isPending || name.trim() === ""}>
              {t("views.issues.queries.save")}
            </Button>
          </form>
        </PopoverContent>
      </Popover>
    </div>
  );
}
