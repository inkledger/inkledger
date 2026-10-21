import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { t } from "@/i18n";

/**
 * Collapsed columns, a user setting (DB) so they follow every device.
 * `scope` keeps boards apart in the shared list ("board:", "dashboard:");
 * values without one (bare status names, from before) are no longer read.
 */
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
    // Whatever happened, the server's list is the one shown next.
    onSettled: () => utils.settings.get.invalidate(),
  });
  const toggle = (column: string) => {
    const id = prefix + column;
    // From the latest list (not this render's): two toggles in a row both count.
    const current = utils.settings.get.getData()?.collapsedColumns ?? all;
    const next = current.includes(id) ? current.filter(c => c !== id) : [...current, id];
    utils.settings.get.setData(undefined, prev => (prev ? { ...prev, collapsedColumns: next } : prev));
    save.mutate({ collapsedColumns: next });
  };
  return { collapsed, toggle };
}
