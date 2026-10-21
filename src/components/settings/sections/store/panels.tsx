import { useId, useState } from "react";
import { ArrowLeft, Bitcoin, Check, CreditCard, KeyRound, ShoppingBag } from "lucide-react";
import { toast } from "sonner";
import type { PaymentMethod, StoreEntry } from "@contracts/store";
import { trpc } from "@/lib/trpc";
import { openExternal } from "@/lib/native";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { Chip } from "@/components/app/Chip";
import { Step, Steps } from "@/components/app/Steps";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { MODULE_TERMS_URL } from "@contracts/store";
import { ExternalLink } from "@/components/app/ExternalLink";
import { formatPrice, nameOf, type Locale } from "./format";

/** The request and payment steps of the product sheet. */

export function PanelHeader({
  icon: Icon,
  title,
  description,
  onBack,
}: {
  icon: typeof KeyRound;
  title: string;
  description: string;
  onBack?: () => void;
}) {
  return (
    <SheetHeader className="border-b p-5">
      {onBack && (
        <Button variant="ghost" size="sm" className="-ml-2 mb-1 self-start text-muted-foreground" onClick={onBack}>
          <ArrowLeft />
          {t("settings.store.back")}
        </Button>
      )}
      <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-primary-strong">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <SheetTitle className="font-display text-title">{title}</SheetTitle>
      <SheetDescription>{description}</SheetDescription>
    </SheetHeader>
  );
}

export function RequestPanel({ entry, locale, onBack }: { entry: StoreEntry; locale: Locale; onBack: () => void }) {
  const utils = trpc.useUtils();
  const name = nameOf(entry, locale);
  const emailId = useId();
  const messageId = useId();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const sent = entry.pending?.status === "pending";
  const send = trpc.store.requestLicense.useMutation({
    onSuccess: () => void utils.store.catalog.invalidate(),
    onError: e => toast.error(e.message),
  });

  return (
    <>
      <PanelHeader
        icon={KeyRound}
        title={t("settings.store.requestSheet.title", { name })}
        description={t("settings.store.requestSheet.description", { name })}
        onBack={onBack}
      />
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={ev => {
          ev.preventDefault();
          send.mutate({ product: entry.product, email: email.trim(), message, locale: locale === "it" ? "it" : "en" });
        }}
      >
        <div className="min-w-0 flex-1 overflow-y-auto p-5">
          <Steps>
            <Step n={1} title={t("settings.store.requestSheet.step1")}>
              {t("settings.store.requestSheet.step1Body")}
            </Step>
            <Step n={2} title={t("settings.store.requestSheet.step2")}>
              {t("settings.store.requestSheet.step2Body")}
            </Step>
            <Step n={3} title={t("settings.store.requestSheet.step3")}>
              {t("settings.store.requestSheet.step3Body")}
            </Step>
          </Steps>
          {sent ? (
            <p role="status" className="mt-6 flex items-start gap-2 rounded-md bg-success-soft px-3 py-2 text-body-sm text-success">
              <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {t("settings.store.requestSheet.sent", { name })}
            </p>
          ) : (
            <div className="mt-6 grid gap-4">
              <div className="grid gap-1.5">
                <label htmlFor={emailId} className="font-medium">
                  {t("settings.store.requestSheet.email")}
                </label>
                <Input id={emailId} type="email" required autoComplete="email" value={email} onChange={ev => setEmail(ev.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor={messageId} className="font-medium">
                  {t("settings.store.requestSheet.message")}
                </label>
                <Textarea
                  id={messageId}
                  rows={4}
                  maxLength={2000}
                  value={message}
                  placeholder={t("settings.store.requestSheet.messagePlaceholder")}
                  onChange={ev => setMessage(ev.target.value)}
                />
              </div>
              <p className="text-caption text-muted-foreground">{t("settings.store.requestSheet.privacy")}</p>
              <TermsNote />
            </div>
          )}
        </div>
        {!sent && (
          <SheetFooter className="flex-row justify-end gap-3 border-t p-5">
            <Button type="submit" disabled={!email.trim() || send.isPending}>
              {send.isPending && <Spinner />}
              {t("settings.store.requestSheet.send")}
            </Button>
          </SheetFooter>
        )}
      </form>
    </>
  );
}

export function PayPanel({ entry, locale, onBack }: { entry: StoreEntry; locale: Locale; onBack: () => void }) {
  const utils = trpc.useUtils();
  const name = nameOf(entry, locale);
  const price = formatPrice(entry, locale);
  const [method, setMethod] = useState<PaymentMethod>("card");
  const [url, setUrl] = useState<string | null>(null);
  const waiting = entry.pending?.status === "pending";
  const checkout = trpc.store.checkout.useMutation({
    onSuccess: r => {
      setUrl(r.url);
      openExternal(r.url);
      void utils.store.catalog.invalidate();
    },
    onError: e => toast.error(e.message),
  });
  const dismiss = trpc.store.dismiss.useMutation({
    onSuccess: () => {
      void utils.store.catalog.invalidate();
      onBack();
    },
  });

  const methods: { id: PaymentMethod; icon: typeof CreditCard; label: string; hint: string; available: boolean; soon: boolean }[] = [
    {
      id: "card",
      icon: CreditCard,
      label: t("settings.store.paySheet.card"),
      hint: t("settings.store.paySheet.cardHint"),
      available: entry.methods.card,
      soon: false,
    },
    {
      id: "bitcoin",
      icon: Bitcoin,
      label: t("settings.store.paySheet.bitcoin"),
      hint: t("settings.store.paySheet.bitcoinHint"),
      available: entry.methods.bitcoin === "on",
      soon: entry.methods.bitcoin === "soon",
    },
  ];
  const shown = methods.filter(m => m.available || m.soon);

  return (
    <>
      <PanelHeader
        icon={ShoppingBag}
        title={t("settings.store.paySheet.title", { name })}
        description={t("settings.store.paySheet.description")}
        onBack={onBack}
      />
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        <p className="font-display text-display tabular">{price}</p>
        {waiting ? (
          <div role="status" className="mt-6 grid gap-3">
            <p className="flex items-start gap-2 text-body-sm text-muted-foreground">
              <Spinner className="mt-0.5 shrink-0" />
              {t("settings.store.paySheet.waiting", { name })}
            </p>
            {url && (
              <Button variant="outline" className="justify-self-start" onClick={() => openExternal(url)}>
                {t("settings.store.paySheet.reopen")}
              </Button>
            )}
          </div>
        ) : (
          <fieldset className="mt-6 grid gap-2">
            <legend className="mb-2 font-medium">{t("settings.store.paySheet.method")}</legend>
            {shown.map(m => (
              <label
                key={m.id}
                data-method={m.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg border p-3 transition-colors",
                  m.available ? "cursor-pointer hover:bg-muted/60" : "cursor-not-allowed opacity-60",
                  method === m.id && m.available && "border-primary bg-primary-soft/40"
                )}
              >
                <input
                  type="radio"
                  name="method"
                  className="sr-only"
                  value={m.id}
                  checked={method === m.id}
                  disabled={!m.available}
                  onChange={() => setMethod(m.id)}
                />
                <m.icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{m.label}</span>
                  <span className="block text-caption text-muted-foreground">{m.hint}</span>
                </span>
                {m.soon && <Chip>{t("settings.store.soon")}</Chip>}
              </label>
            ))}
          </fieldset>
        )}
        {!waiting && (
          <div className="mt-4">
            <TermsNote />
          </div>
        )}
      </div>
      <SheetFooter className="flex-row justify-end gap-3 border-t p-5">
        {waiting ? (
          <Button variant="ghost" onClick={() => dismiss.mutate({ product: entry.product })}>
            {t("settings.store.paySheet.cancel")}
          </Button>
        ) : (
          <Button
            className="tabular"
            disabled={!shown.find(m => m.id === method)?.available || checkout.isPending}
            onClick={() => checkout.mutate({ product: entry.product, method })}
          >
            {checkout.isPending && <Spinner />}
            {t("settings.store.paySheet.pay", { price })}
          </Button>
        )}
      </SheetFooter>
    </>
  );
}

/** Sending a request or paying accepts the module terms: said where it happens. */
function TermsNote() {
  return (
    <p className="text-caption text-muted-foreground">
      {t("settings.store.terms.accept")} <ExternalLink url={MODULE_TERMS_URL}>{t("settings.store.terms.link")}</ExternalLink>.
    </p>
  );
}
