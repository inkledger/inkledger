import { mediumDate } from "@/lib/dates";
import { toastError } from "@/lib/errorText";
import { useRef, useState } from "react";
import { ChevronDown, Copy, Download, FileDown, FileUp, KeyRound, Server, Settings2, Trash2 } from "lucide-react";
import { ActivationDialog } from "./ActivationDialog";
import { toast } from "sonner";
import { PROGRESS_FILE_EXTENSION, type ModuleStatus } from "@contracts/modules";
import { LICENSE_FILE_EXTENSION } from "@contracts/store";
import { downloadBlob } from "@/lib/download";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { LicenceProof } from "@/components/settings/sections/store/LicenceProof";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const TONES = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  muted: "bg-muted text-muted-foreground",
} as const;

function badgeOf(installed: ModuleStatus | null, licensed: boolean, off: boolean): { label: string; tone: keyof typeof TONES } {
  switch (installed?.state) {
    case "active":
      return off ? { label: t("settings.store.switch.badge"), tone: "muted" } : { label: t("settings.store.active"), tone: "success" };
    case "needs-license":
      return { label: t("settings.store.status.needsLicense"), tone: "warning" };
    case "needs-activation":
      return { label: t("settings.store.status.needsActivation"), tone: "warning" };
    case "unsupported-host-api":
      return { label: t("settings.store.unsupported"), tone: "warning" };
    case "invalid":
      return { label: t("settings.store.status.invalid", { reason: installed.reason }), tone: "danger" };
    default:
      return licensed ? { label: t("settings.store.licensed"), tone: "success" } : { label: "", tone: "success" };
  }
}

/**
 * The status of a module this server holds (installed and/or licensed), as a
 * badge that opens its management: the licence, uninstall, remove the licence.
 */
export function ManageBadge({
  product,
  moduleId,
  name,
  installed,
  licensed,
  onSettings,
}: {
  product: string;
  moduleId: string;
  name: string;
  installed: ModuleStatus | null;
  licensed: boolean;
  /** Opens the module's settings, when it has some. */
  onSettings?: () => void;
}) {
  const utils = trpc.useUtils();
  const list = trpc.modules.list.useQuery().data;
  const licences = (list?.licenses ?? []).filter(l => l.product === product);
  const off = list?.off.includes(moduleId) ?? false;
  const [confirm, setConfirm] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [servers, setServers] = useState(false);
  const progressInput = useRef<HTMLInputElement>(null);
  const active = installed?.state === "active" && !off;
  const refresh = () => {
    void utils.modules.list.invalidate();
    void utils.store.catalog.invalidate();
  };
  const uninstall = trpc.modules.uninstall.useMutation({
    onSuccess: () => {
      toast.success(t("settings.store.manage.uninstalled", { name }));
      refresh();
    },
  });
  const removeLicense = trpc.modules.removeLicense.useMutation({
    onSuccess: () => {
      toast.success(t("settings.store.manage.licenceRemoved", { name }));
      refresh();
    },
  });

  const importProgress = trpc.modules.importProgress.useMutation({
    // The module reads its data when it mounts: start it again with what came back.
    onSuccess: () => {
      toast.success(t("settings.store.manage.progressImported", { name }));
      setTimeout(() => window.location.reload(), 600);
    },
    onError: e => toastError(e),
  });

  const exportProgress = async () => {
    try {
      const file = await utils.modules.exportProgress.fetch({ id: moduleId });
      const blob = new Blob([JSON.stringify(file, null, 2) + "\n"], { type: "application/json" });
      downloadBlob(`${moduleId}${PROGRESS_FILE_EXTENSION}`, blob);
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  };

  const exportLicence = async (how: "file" | "copy") => {
    try {
      const file = await utils.modules.exportLicense.fetch({ product });
      if (how === "copy") {
        await navigator.clipboard.writeText(file.license);
        toast.success(t("settings.store.manage.copied"));
      } else {
        const blob = new Blob([JSON.stringify(file, null, 2) + "\n"], { type: "application/json" });
        downloadBlob(`${moduleId}${LICENSE_FILE_EXTENSION}`, blob);
      }
    } catch (e) {
      toastError(e);
    }
  };

  if (!installed && !licensed) return null;
  const badge = badgeOf(installed, licensed, off);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("settings.store.manage.open", { name, status: badge.label })}
          className={cn(
            "inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-sm px-2 text-caption font-medium outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring",
            TONES[badge.tone]
          )}
        >
          {badge.label}
          <ChevronDown className="h-3 w-3" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="font-medium">{name}</DropdownMenuLabel>
          {licences.length > 0 ? (
            licences.map(l => (
              <div key={l.id} className="flex items-start gap-2 px-2 pb-1.5 text-caption text-muted-foreground">
                <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <p>
                  <span className="block text-foreground">{t("settings.store.manage.licence", { id: l.label, date: mediumDate(l.issued) })}</span>
                  <span className="block">{t(`settings.store.issuer.${l.issuer ?? "unknown"}`)}</span>
                  <span className="block">{t("settings.store.manage.forever")}</span>
                  <LicenceProof id={l.id} compact />
                </p>
              </div>
            ))
          ) : (
            <p className="px-2 pb-1.5 text-caption text-muted-foreground">{t("settings.store.manage.noLicence")}</p>
          )}
          <DropdownMenuSeparator />
          {active && onSettings && (
            <DropdownMenuItem onSelect={onSettings}>
              <Settings2 />
              {t("settings.store.moduleSettings.open")}
            </DropdownMenuItem>
          )}
          {active && (
            <>
              <DropdownMenuItem onSelect={() => void exportProgress()}>
                <FileDown />
                {t("settings.store.manage.exportProgress")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => progressInput.current?.click()}>
                <FileUp />
                {t("settings.store.manage.importProgress")}
              </DropdownMenuItem>
            </>
          )}
          {installed && (
            <DropdownMenuItem onSelect={() => setConfirmUninstall(true)}>
              <Trash2 />
              {t("settings.store.manage.uninstall")}
            </DropdownMenuItem>
          )}
          {licences.length > 0 && (
            <DropdownMenuItem onSelect={() => setServers(true)}>
              <Server />
              {t("settings.store.activation.menu")}
            </DropdownMenuItem>
          )}
          {licences.length > 0 && (
            <>
              <DropdownMenuItem onSelect={() => void exportLicence("file")}>
                <Download />
                {t("settings.store.manage.download")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportLicence("copy")}>
                <Copy />
                {t("settings.store.manage.copy")}
              </DropdownMenuItem>
            </>
          )}
          {licences.length > 0 && (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>
              <KeyRound />
              {t("settings.store.manage.removeLicence")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {servers && <ActivationDialog product={product} name={name} open={servers} onOpenChange={setServers} />}
      <input
        ref={progressInput}
        type="file"
        accept={`${PROGRESS_FILE_EXTENSION},application/json`}
        className="hidden"
        aria-label={t("settings.store.manage.importProgress")}
        onChange={e => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void f.text().then(text => importProgress.mutate({ text }));
        }}
      />

      <AlertDialog open={confirmUninstall} onOpenChange={setConfirmUninstall}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.store.manage.uninstallTitle", { name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.store.manage.uninstallBody", { name })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            {active && (
              <AlertDialogAction
                className={buttonVariants({ variant: "outline" })}
                onClick={() => void exportProgress().then(ok => ok && uninstall.mutate({ id: moduleId }))}
              >
                <FileDown />
                {t("settings.store.manage.exportAndUninstall")}
              </AlertDialogAction>
            )}
            <AlertDialogAction destructive onClick={() => uninstall.mutate({ id: moduleId })}>
              {t("settings.store.manage.uninstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.store.manage.confirmTitle", { name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.store.manage.confirmBody", { name })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction destructive onClick={() => removeLicense.mutate({ product })}>
              {t("settings.store.manage.removeLicence")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
