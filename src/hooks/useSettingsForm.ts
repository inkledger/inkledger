import { useIsMutating } from "@tanstack/react-query";
import { getMutationKey } from "@trpc/react-query";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { t } from "@/i18n";

export type SettingsData = {
  timerAlertMinutes: number;
  notifyEnabled: number;
  idleMinutes: number;
  overlapPolicy: "warn" | "block";
  goalBasis: "logged" | "clock";
};
export type SettingsPatch = Partial<SettingsData>;

const SETTINGS_KEYS: (keyof SettingsData)[] = ["timerAlertMinutes", "notifyEnabled", "idleMinutes", "overlapPolicy", "goalBasis"];

/**
 * The user's settings and `persist(patch)`: optimistic, so a field never
 * flips back while saving; every field saves itself (no "Save").
 */
export function useSettingsForm() {
  const utils = trpc.useUtils();
  const query = trpc.settings.get.useQuery();
  const update = trpc.settings.update.useMutation({
    onMutate: async vars => {
      await utils.settings.get.cancel();
      const previous = utils.settings.get.getData();
      if (previous) {
        const next = { ...previous };
        for (const k of SETTINGS_KEYS) {
          const v = vars[k];
          if (v !== undefined) Object.assign(next, { [k]: v });
        }
        utils.settings.get.setData(undefined, next);
      }
      return { previous };
    },
    onSuccess: () => toast.success(t("ui.settingsForm.saved")),
    onError: (e, _vars, ctx) => {
      if (ctx?.previous) utils.settings.get.setData(undefined, ctx.previous);
      toast.error(t("ui.settingsForm.failed", { message: e.message }));
    },
    onSettled: () => utils.settings.get.invalidate(),
  });
  return { query, data: query.data, persist: (patch: SettingsPatch) => update.mutate(patch) };
}

/** A settings save is in flight (any section): the header says so. */
export function useSettingsSaving(): boolean {
  return useIsMutating({ mutationKey: getMutationKey(trpc.settings.update) }) > 0;
}
