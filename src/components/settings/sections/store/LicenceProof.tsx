import { Download, ShieldCheck } from "lucide-react";
import { Chip } from "@/components/app/Chip";
import { Button } from "@/components/ui/button";
import { mediumDate } from "@/lib/dates";
import { toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

/**
 * A licence's timestamp on Bitcoin (docs/work/ideas/onchain-licences.md R-4.6), as this
 * server checks it: anchored, being anchored, unchecked for want of a network, or not
 * matching. Nothing when it has none. `compact`: one line, for a menu.
 */
export function LicenceProof({ id, compact = false }: { id: string; compact?: boolean }) {
  const utils = trpc.useUtils();
  const proof = trpc.modules.licenceProof.useQuery({ id }, { staleTime: 60 * 60_000, retry: false });
  const p = proof.data;
  if (!p || p.status === "none") return null;
  const line =
    p.status === "pending"
      ? { tone: "neutral" as const, text: t("settings.store.proof.pending") }
      : p.status === "failed"
        ? { tone: "danger" as const, text: t("settings.store.proof.failed") }
        : p.status === "unverified" || p.time === null
          ? { tone: "neutral" as const, text: t("settings.store.proof.offline") }
          : p.existedBy
            ? { tone: "success" as const, text: t("settings.store.proof.existedBy", { date: mediumDate(p.time) }) }
            : { tone: "success" as const, text: t("settings.store.proof.done", { date: mediumDate(p.time), block: p.block ?? "" }) };
  if (compact) return <span className="block">{line.text}</span>;
  const download = async () => {
    try {
      const file = await utils.modules.licenceProofFile.fetch({ id });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([Uint8Array.from(atob(file.base64), c => c.charCodeAt(0))], { type: "application/octet-stream" }));
      a.download = file.filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <span className="mt-1 grid gap-1.5" data-testid="licence-proof">
      <span className="flex flex-wrap items-center gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <Chip tone={line.tone}>{line.text}</Chip>
      </span>
      {p.status !== "pending" && (
        <span className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={proof.isFetching} onClick={() => void proof.refetch()}>
            {proof.isFetching ? t("settings.store.proof.checking") : t("settings.store.proof.verify")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void download()}>
            <Download className="h-3.5 w-3.5" aria-hidden /> {t("settings.store.proof.download")}
          </Button>
        </span>
      )}
    </span>
  );
}
