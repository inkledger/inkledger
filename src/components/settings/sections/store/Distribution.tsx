import { useMemo, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../../api/router";
import { toast } from "sonner";
import { UserPlus, Users, X } from "lucide-react";
import type { StoreEntry } from "@contracts/store";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { toastError } from "@/lib/errorText";
import { SectionLabel } from "@/components/app/PageHeader";
import { SegmentedControl } from "@/components/app/SegmentedControl";
import { ExternalLink } from "@/components/app/ExternalLink";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { currentLocale } from "@/i18n";
import { nameOf, type Locale } from "./format";

type Dist = inferRouterOutputs<AppRouter>["store"]["distribution"];
type Payer = Dist["licences"][number]["payer"];

/** Who paid a licence, in words. */
function payerText(d: Dist, holder: number | null, payer: Payer): string {
  if (!payer || payer.id === null) return t("settings.store.dist.paidUnknown");
  if (payer.kind === "team") return t("settings.store.dist.paidTeam", { name: d.teams.find(x => x.id === payer.id)?.name ?? "?" });
  if (payer.id === holder) return t("settings.store.dist.paidSelf");
  return t("settings.store.dist.paidUser", { name: d.people.find(p => p.id === payer.id)?.name ?? "?" });
}

/**
 * Settings › Store, a module's sheet, for a Store manager: who gets it. Its licences (one
 * person each, who paid, move one), what waits for whom (a paid one claimed with its code),
 * its offers, and Offer… / Assign… (docs/it/who-pays.md).
 */
export function Distribution({ entry, locale }: { entry: StoreEntry; locale: Locale }) {
  const utils = trpc.useUtils();
  const dist = trpc.store.distribution.useQuery({ product: entry.product });
  const [dialog, setDialog] = useState<"offer" | "assign" | null>(null);
  const refresh = () => {
    void utils.store.distribution.invalidate();
    void utils.store.catalog.invalidate();
    void utils.modules.list.invalidate();
  };
  const reassign = trpc.store.reassign.useMutation({ onSuccess: () => (toast.success(t("settings.store.dist.moved")), refresh()), onError: e => toastError(e) });
  const withdraw = trpc.store.withdrawOffer.useMutation({ onSuccess: refresh, onError: e => toastError(e) });
  const d = dist.data;
  if (!d) return null;
  const personName = (id: number | null) => d.people.find(p => p.id === id)?.name ?? "?";
  return (
    <section className="border-b p-5" data-store-distribution>
      <SectionLabel as="h3" className="mb-1 px-0">{t("settings.store.dist.title")}</SectionLabel>
      <p className="mb-3 text-body-sm text-muted-foreground">{t("settings.store.dist.hint")}</p>

      <p className="mb-2 text-body-sm font-medium">{d.licences.length ? t("settings.store.dist.licences", { count: d.licences.length }) : t("settings.store.dist.licencesNone")}</p>
      <ul className="mb-4 grid gap-2">
        {d.licences.map(l => {
          const own = l.payer?.kind === "user" && l.payer.id !== null && l.payer.id === l.holderUserId;
          return (
            <li key={l.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-body-sm">
              <span className="min-w-0">
                <span className="block truncate">{l.holderUserId === null ? t("settings.store.dist.free") : personName(l.holderUserId)}</span>
                <span className="block truncate text-caption text-muted-foreground">{l.label} · {payerText(d, l.holderUserId, l.payer)}</span>
              </span>
              {!own && (
                <Select value="" onValueChange={v => reassign.mutate({ licence: l.id, userId: Number(v) })}>
                  <SelectTrigger className="w-40" aria-label={t("settings.store.dist.moveTo", { licence: l.label })}>
                    <SelectValue placeholder={t("settings.store.dist.moveTo", { licence: "" }).trim()} />
                  </SelectTrigger>
                  <SelectContent>
                    {d.people.filter(p => p.id !== l.holderUserId && !d.licences.some(x => x.holderUserId === p.id)).map(p => (
                      <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </li>
          );
        })}
        {d.pending.map(p => (
          <PendingRow key={`${p.for}-${p.kind}`} product={entry.product} name={personName(p.for)} forId={p.for} kind={p.kind} status={p.status} onDone={refresh} />
        ))}
      </ul>

      <p className="mb-2 text-body-sm font-medium">{t("settings.store.dist.offers")}</p>
      {d.offers.length === 0 ? (
        <p className="mb-3 text-body-sm text-muted-foreground">{t("settings.store.dist.offersNone")}</p>
      ) : (
        <ul className="mb-3 flex flex-wrap gap-2">
          {d.offers.map(o => {
            const name = o.teamId !== null ? t("settings.store.dist.teamLabel", { name: d.teams.find(x => x.id === o.teamId)?.name ?? "?" }) : personName(o.userId);
            return (
              <li key={o.id} className="inline-flex max-w-full items-center gap-1 rounded-sm bg-muted px-2 py-0.5 text-caption">
                <span className="truncate" title={name}>{name}</span>
                <Button variant="ghost" size="icon-sm" aria-label={t("settings.store.dist.withdraw", { name })} onClick={() => withdraw.mutate({ id: o.id })}>
                  <X />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setDialog("offer")}>
          <UserPlus />
          {t("settings.store.dist.offer")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setDialog("assign")}>
          <Users />
          {t("settings.store.dist.assign")}
        </Button>
      </div>
      {dialog && <GiveDialog entry={entry} locale={locale} dist={d} mode={dialog} onClose={() => setDialog(null)} onDone={refresh} />}
    </section>
  );
}

/** A licence waiting for its person: requested (it lands by itself) or to pay (its code claims it). */
function PendingRow({ product, name, forId, kind, status, onDone }: { product: string; name: string; forId: number; kind: "request" | "paid"; status: string; onDone: () => void }) {
  const [code, setCode] = useState("");
  const claim = trpc.store.claimPaid.useMutation({ onSuccess: () => (toast.success(t("settings.store.dist.claimed", { name })), onDone()), onError: e => toastError(e) });
  const dismiss = trpc.store.dismiss.useMutation({ onSuccess: onDone, onError: e => toastError(e) });
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-body-sm">
      <span className="min-w-0 truncate text-muted-foreground">
        {t("settings.store.dist.waiting", { name })} · {t(kind === "paid" ? "settings.store.dist.waitingPaid" : "settings.store.dist.waitingRequest")}
        {status !== "pending" ? ` · ${status}` : ""}
      </span>
      {status !== "pending" && (
        <Button variant="ghost" size="sm" onClick={() => dismiss.mutate({ product, for: forId })}>
          {t("settings.store.dismiss")}
        </Button>
      )}
      {kind === "paid" && status === "pending" && (
        <form
          className="flex items-center gap-2"
          onSubmit={ev => {
            ev.preventDefault();
            if (code.trim()) claim.mutate({ product, code: code.trim(), for: forId });
          }}
        >
          <Input className="w-36" value={code} onChange={e => setCode(e.target.value)} aria-label={t("settings.store.dist.code", { name })} />
          <Button size="sm" type="submit" disabled={claim.isPending}>{t("settings.store.dist.claim")}</Button>
        </form>
      )}
    </li>
  );
}

/** Offer… or Assign…: to a person or a team; assigning lists who gets a licence (one each) and their addresses. */
function GiveDialog({ entry, locale, dist, mode: initial, onClose, onDone }: { entry: StoreEntry; locale: Locale; dist: Dist; mode: "offer" | "assign"; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState(initial);
  const [target, setTarget] = useState<"person" | "team">("person");
  const [picked, setPicked] = useState<string>("");
  const [emails, setEmails] = useState<Record<number, string>>({});
  const [left, setLeft] = useState<Set<number>>(new Set());
  const [links, setLinks] = useState<{ userId: number; url: string }[] | null>(null);
  const name = nameOf(entry, locale);
  const team = target === "team" ? dist.teams.find(x => String(x.id) === picked) : undefined;
  const people = useMemo(
    () => (target === "team" ? dist.people.filter(p => team?.members.includes(p.id)) : dist.people.filter(p => String(p.id) === picked)),
    [dist.people, picked, target, team]
  );
  const chosen = people.filter(p => !left.has(p.id));
  const addr = (id: number, fallback: string) => emails[id] ?? fallback;
  const offer = trpc.store.offer.useMutation({ onSuccess: () => (toast.success(t("settings.store.dist.offered")), onDone(), onClose()), onError: e => toastError(e) });
  const assign = trpc.store.assign.useMutation({
    onSuccess: r => {
      toast.success(t("settings.store.dist.assigned", { count: r.started.length, skipped: r.skipped.length }));
      for (const f of r.failed) toastError(new Error(`${dist.people.find(p => p.id === f.userId)?.name ?? "?"}: ${f.message}`));
      onDone();
      const pay = r.started.flatMap(s => (s.url ? [{ userId: s.userId, url: s.url }] : []));
      if (pay.length) setLinks(pay);
      else onClose();
    },
    onError: e => toastError(e),
  });
  const count = chosen.length;
  const ready = picked !== "" && (mode === "offer" || (count > 0 && chosen.every(p => /.+@.+\..+/.test(addr(p.id, p.email)))));
  const submit = () => {
    if (mode === "offer") offer.mutate(target === "team" ? { product: entry.product, teamId: Number(picked) } : { product: entry.product, userId: Number(picked) });
    else
      assign.mutate({
        product: entry.product,
        kind: entry.mode === "paid" ? "paid" : "request",
        teamId: team?.id,
        people: chosen.map(p => ({ userId: p.id, email: addr(p.id, p.email) })),
        locale: currentLocale() === "it" ? "it" : "en",
      });
  };
  const countText = count === 1 ? t("settings.store.dist.countOne") : t("settings.store.dist.count", { count });
  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings.store.dist.dialogTitle", { name })}</DialogTitle>
          <DialogDescription>
            {mode === "offer" ? t("settings.store.dist.offerHint") : t("settings.store.dist.assignHint", { payer: t(target === "team" ? "settings.store.dist.payerTeam" : "settings.store.dist.payerYou") })}
          </DialogDescription>
        </DialogHeader>
        {links ? (
          <div className="grid gap-2 text-body-sm">
            <p>{t("settings.store.dist.payLinks")}</p>
            <ul className="grid gap-1">
              {links.map(l => (
                <li key={l.userId}>
                  <ExternalLink url={l.url}>{t("settings.store.dist.pay", { name: dist.people.find(p => p.id === l.userId)?.name ?? "?" })}</ExternalLink>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="grid min-w-0 gap-4">
            <SegmentedControl
              label={t("settings.store.dist.mode")}
              value={mode}
              onChange={setMode}
              options={[
                { value: "offer", label: t("settings.store.dist.modeOffer") },
                { value: "assign", label: t("settings.store.dist.modeAssign") },
              ]}
            />
            <SegmentedControl
              label={t("settings.store.dist.target")}
              value={target}
              onChange={v => {
                setTarget(v);
                setPicked("");
                setLeft(new Set());
              }}
              options={[
                { value: "person", label: t("settings.store.dist.targetPerson") },
                { value: "team", label: t("settings.store.dist.targetTeam") },
              ]}
            />
            <div className="grid gap-1.5">
              <Label htmlFor="dist-pick">{t(target === "team" ? "settings.store.dist.team" : "settings.store.dist.person")}</Label>
              <Select value={picked} onValueChange={setPicked}>
                <SelectTrigger id="dist-pick">
                  <SelectValue placeholder={t("settings.store.dist.pick")} />
                </SelectTrigger>
                <SelectContent>
                  {(target === "team" ? dist.teams.map(x => ({ id: x.id, name: x.name })) : dist.people).map(o => (
                    <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {mode === "assign" && picked !== "" && (
              <div className="grid min-w-0 gap-2" data-dist-people>
                {target === "team" && people.length === 0 && <p className="text-body-sm text-muted-foreground">{t("settings.store.dist.noMembers")}</p>}
                {people.map(p => (
                  <div key={p.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
                    <Checkbox
                      checked={!left.has(p.id)}
                      aria-label={t("settings.store.dist.include", { name: p.name })}
                      onCheckedChange={v => setLeft(s => { const n = new Set(s); if (v) n.delete(p.id); else n.add(p.id); return n; })}
                    />
                    <Input
                      value={addr(p.id, p.email)}
                      disabled={left.has(p.id)}
                      onChange={e => setEmails(m => ({ ...m, [p.id]: e.target.value }))}
                      aria-label={t("settings.store.dist.email", { name: p.name })}
                      placeholder={p.name}
                    />
                  </div>
                ))}
                <p className="text-body-sm font-medium tabular" data-dist-count>{countText}</p>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          {links ? (
            <Button onClick={onClose}>{t("common.close")}</Button>
          ) : (
            <Button disabled={!ready || offer.isPending || assign.isPending} onClick={submit}>
              {mode === "offer" ? t("settings.store.dist.confirmOffer") : t("settings.store.dist.confirmAssign", { count: countText })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
