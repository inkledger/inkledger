import { failureText } from "@/lib/errorText";
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { t } from "@/i18n";

/**
 * Collapsed columns, a user setting (DB) so they follow every device.
 * `scope` keeps boards apart in the shared list ("board:", "dashboard:");
 * values without one (bare status names, from before) are no longer read.
 */
/** Saves of the list under way, every board's (they share one setting), and the list they lead to. */
const saving: { count: number; intended: string[] | null } = { count: 0, intended: null };

/** Signing out: the list a save under way leads to is the previous account's, never the next one's base. */
export function forgetCollapsedSaves(): void {
  saving.intended = null;
}

/**
 * The whole list after toggling `id`, from the list the saves under way lead to, else the latest copy
 * of the setting. Null while neither is known: the server replaces the whole list, so a toggle built on
 * nothing would unfold every board's columns.
 */
export function toggledColumns(id: string, intended: string[] | null, latest: string[] | undefined): string[] | null {
  const current = intended ?? latest;
  if (!current) return null;
  return current.includes(id) ? current.filter(c => c !== id) : [...current, id];
}

export function useCollapsedColumns(scope?: string) {
  const utils = trpc.useUtils();
  const settings = trpc.settings.get.useQuery();
  const prefix = scope ? `${scope}:` : "";
  const all = useMemo(
    () => settings.data?.collapsedColumns ?? [],
    [settings.data]
  );
  const collapsed = useMemo(
    () =>
      new Set(
        all
          .filter(c => (prefix ? c.startsWith(prefix) : !c.includes(":")))
          .map(c => c.slice(prefix.length))
      ),
    [all, prefix]
  );
  // Saves of the list go one after another (a scope of their own): a later one can't
  // reach the server before an earlier one and be overwritten by it.
  const save = trpc.settings.update.useMutation({
    scope: { id: "settings.collapsedColumns" },
    onError: e => {
      toast.error(t("ui.columns.saveFailed", { message: failureText(e) }));
    },
    // Once the last save in the row is done, the server's list is the one shown:
    // read before that, it would lack the saves still waiting their turn.
    onSettled: () => {
      if (--saving.count === 0) {
        saving.intended = null;
        void utils.settings.get.invalidate();
      }
    },
  });
  const toggle = (column: string) => {
    // From the list the saves under way lead to (or the latest copy): every toggle counts,
    // whatever a read in between showed. Not before the setting is read.
    const next = toggledColumns(prefix + column, saving.intended, utils.settings.get.getData()?.collapsedColumns);
    if (!next) return;
    // A read on its way would overwrite this toggle when it lands.
    void utils.settings.get.cancel();
    saving.intended = next;
    saving.count++;
    utils.settings.get.setData(undefined, prev => (prev ? { ...prev, collapsedColumns: next } : prev));
    save.mutate({ collapsedColumns: next });
  };
  return { collapsed, toggle };
}
