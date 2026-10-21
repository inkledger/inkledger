import { toast } from "sonner";
import type { ModuleStatus } from "@contracts/modules";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { Switch } from "@/components/ui/switch";

/** Turns one installed, working module off or on for this user (on every device). */
export function ModuleSwitch({ moduleId, name, installed }: { moduleId: string; name: string; installed: ModuleStatus | null }) {
  const utils = trpc.useUtils();
  const off = trpc.modules.list.useQuery().data?.off ?? [];
  const set = trpc.modules.setEnabled.useMutation({
    onSuccess: r => {
      toast.success(t(r.enabled ? "settings.store.switch.on" : "settings.store.switch.off", { name }));
      void utils.modules.list.invalidate();
    },
    onError: e => toast.error(e.message),
  });
  if (installed?.state !== "active") return null;
  const on = !off.includes(moduleId);
  return (
    <Switch
      checked={on}
      disabled={set.isPending}
      aria-label={t("settings.store.switch.label", { name })}
      title={t(on ? "settings.store.switch.hintOn" : "settings.store.switch.hintOff")}
      onCheckedChange={enabled => set.mutate({ id: moduleId, enabled })}
    />
  );
}
