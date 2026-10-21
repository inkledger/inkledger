import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { t } from "@/i18n";

/**
 * Collapsed columns, a user setting (DB) so they follow every device.
 * `scope` keeps boards apart in the shared list ("dashboard:" prefix); the
 * Board uses the bare status names, as it always did.
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
  const save = trpc.settings.update.useMutation({
    onMutate: async ({ collapsedColumns }) => {
      await utils.settings.get.cancel();
      const previous = utils.settings.get.getData();
      if (previous && collapsedColumns)
        utils.settings.get.setData(undefined, {
          ...previous,
          collapsedColumns,
        });
      return { previous };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.previous) utils.settings.get.setData(undefined, ctx.previous);
      toast.error(t("ui.columns.saveFailed", { message: e.message }));
    },
  });
  const toggle = (column: string) => {
    const id = prefix + column;
    const next = all.includes(id) ? all.filter(c => c !== id) : [...all, id];
    save.mutate({ collapsedColumns: next });
  };
  return { collapsed, toggle };
}
