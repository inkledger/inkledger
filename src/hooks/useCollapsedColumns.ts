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
      toast.error(t("ui.columns.saveFailed", { message: e.message }));
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
    const id = prefix + column;
    // A read on its way would overwrite this toggle when it lands.
    void utils.settings.get.cancel();
    // From the list the saves under way lead to (or the latest copy): every toggle counts,
    // whatever a read in between showed.
    const current = saving.intended ?? utils.settings.get.getData()?.collapsedColumns ?? all;
    const next = current.includes(id) ? current.filter(c => c !== id) : [...current, id];
    saving.intended = next;
    saving.count++;
    utils.settings.get.setData(undefined, prev => (prev ? { ...prev, collapsedColumns: next } : prev));
    save.mutate({ collapsedColumns: next });
  };
  return { collapsed, toggle };
}
