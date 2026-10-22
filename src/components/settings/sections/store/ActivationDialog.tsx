import { toastError } from "@/lib/errorText";
import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { QrCode } from "@/components/app/QrCode";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { dateFormat, t } from "@/i18n";
import { surface } from "@/components/app/surface";

const day = () => dateFormat({ dateStyle: "medium" });

/**
 * A licence's servers (WP-19): whether it is active on this one, how many it
 * is active on out of how many it allows; activate or free this server; and,
 * without the store from here, the code to take to the store's page and the
 * token to bring back.
 */
export function ActivationDialog({ product, name, open, onOpenChange }: { product: string; name: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const utils = trpc.useUtils();
  const info = trpc.modules.activation.useQuery({ product }, { enabled: open, retry: false });
  const [offline, setOffline] = useState(false);
  const code = trpc.modules.offlineCode.useQuery({ product }, { enabled: open && (offline || !!info.data?.offline) });
  const [pasted, setPasted] = useState("");
  const done = (msg: string) => {
    toast.success(msg);
    void utils.modules.invalidate();
    void utils.store.catalog.invalidate();
  };
  const activate = trpc.modules.activate.useMutation({ onSuccess: () => done(t("settings.store.activation.activated", { name })), onError: e => toastError(e) });
  const deactivate = trpc.modules.deactivate.useMutation({ onSuccess: () => done(t("settings.store.activation.freed", { name })), onError: e => toastError(e) });
  const accept = trpc.modules.acceptToken.useMutation({
    onSuccess: () => {
      setPasted("");
      done(t("settings.store.activation.activated", { name }));
    },
    onError: e => toastError(e),
  });
  const state = info.data?.state;
  const servers = info.data?.servers;
  const here = servers?.active.some(s => s.instanceId === servers.here) ?? false;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.store.activation.title", { name })}</DialogTitle>
          <DialogDescription>{t("settings.store.activation.hint")}</DialogDescription>
        </DialogHeader>
        {info.data && !info.data.required ? (
          <p className="text-body-sm text-muted-foreground">{t("settings.store.activation.notRequired")}</p>
        ) : (
          <div className="grid gap-3 text-body-sm">
            <p>
              {state?.state === "active"
                ? t("settings.store.activation.activeUntil", { date: day().format(state.exp) })
                : state?.state === "grace"
                  ? t("settings.store.activation.grace", { date: day().format(state.until) })
                  : t("settings.store.activation.notActive")}
            </p>
            {servers && (
              <p className="font-medium" aria-label={t("settings.store.activation.serversLabel")}>
                {t("settings.store.activation.servers", { active: servers.active.length, limit: servers.limit })}
              </p>
            )}
            {!info.data?.offline && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={activate.isPending} onClick={() => activate.mutate({ product })}>
                  {state?.state === "active" ? t("settings.store.activation.renew") : t("settings.store.activation.activate")}
                </Button>
                {(here || state?.state === "active") && (
                  <Button size="sm" variant="outline" disabled={deactivate.isPending} onClick={() => deactivate.mutate({ product })}>
                    {t("settings.store.activation.free")}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setOffline(o => !o)}>
                  {t("settings.store.activation.offline")}
                </Button>
              </div>
            )}
            {code.data && (
              <div {...surface("card")} className="grid gap-2 rounded-lg border p-3">
                <p className="text-caption text-muted-foreground">{t("settings.store.activation.offlineHint", { page: code.data.page })}</p>
                <span {...surface("picture")} className="mx-auto flex w-fit rounded-lg">
                  <QrCode value={code.data.code} label={t("settings.store.activation.code")} className="h-40 w-40" />
                </span>
                <Textarea readOnly value={code.data.code} aria-label={t("settings.store.activation.code")} className="text-caption" rows={3} />
                <Textarea value={pasted} onChange={e => setPasted(e.target.value)} placeholder={t("settings.store.activation.pastePlaceholder")} aria-label={t("settings.store.activation.paste")} rows={3} />
                <Button size="sm" disabled={pasted.trim().length < 10 || accept.isPending} onClick={() => accept.mutate({ product, token: pasted })}>
                  {t("settings.store.activation.useToken")}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
