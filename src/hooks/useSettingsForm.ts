import { failureText } from "@/lib/errorText";
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
};
export type SettingsPatch = Partial<SettingsData>;

const SETTINGS_KEYS: (keyof SettingsData)[] = ["timerAlertMinutes", "notifyEnabled", "idleMinutes", "overlapPolicy"];

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
      toast.error(t("ui.settingsForm.failed", { message: failureText(e) }));
    },
    onSettled: () => utils.settings.get.invalidate(),
  });
  return { query, data: query.data, persist: (patch: SettingsPatch) => update.mutate(patch) };
}

/**
 * A settings switch or choice that shows at once: the field changes in the
 * cache as it is sent (a switch's true/false as the stored 1/0), back as it was
 * if refused; the answer is then the truth. Only the settings are read again,
 * never the page.
 */
export function useSettingsSave() {
  const utils = trpc.useUtils();
  return trpc.settings.update.useMutation({
    onMutate: async vars => {
      await utils.settings.get.cancel();
      const previous = utils.settings.get.getData();
      if (previous) {
        const known: Record<string, unknown> = previous;
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(vars)) {
          if (v === undefined || !(k in known)) continue;
          const was = known[k];
          if (typeof was === "number" && typeof v === "boolean") patch[k] = v ? 1 : 0;
          else if (typeof was === typeof v) patch[k] = v;
        }
        utils.settings.get.setData(undefined, Object.assign({ ...previous }, patch));
      }
      return { previous };
    },
    onSuccess: data => utils.settings.get.setData(undefined, data),
    onError: (e, _vars, ctx) => {
      if (ctx?.previous) utils.settings.get.setData(undefined, ctx.previous);
      toast.error(t("ui.settingsForm.failed", { message: failureText(e) }));
    },
  });
}

/** A settings save is in flight (any section): the header says so. */
export function useSettingsSaving(): boolean {
  return useIsMutating({ mutationKey: getMutationKey(trpc.settings.update) }) > 0;
}
