import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { BrandMark } from "@/components/app/BrandMark";
import { BRAND_SHORT } from "@/lib/brand";
import { LanguagePicker } from "@/components/app/LanguagePicker";
import { t } from "@/i18n";

const benefits = () => [t("pages.login.benefit1"), t("pages.login.benefit2"), t("pages.login.benefit3")];

/** The signed-out pages' frame: the cover on one side, a card for the form on the other. */
export function AuthShell({ heading, intro, children, footer }: { heading: string; intro?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="safe-top safe-bottom grid min-h-dvh gap-3 bg-canvas p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:p-4">
      <aside className="grain cover-sunset flex flex-col justify-between gap-8 rounded-xl p-6 text-cover-title lg:p-10">
        <div className="flex items-center gap-3">
          {/* On the gradient itself: the mark sits on paper, so it still reads as a tile. */}
          <BrandMark className="h-11 w-11 shadow-sm ring-1 ring-cover-title/10" />
          <span className="font-display text-title">{BRAND_SHORT}</span>
        </div>
        <div>
          <p className="font-display text-title lg:text-display">{t("pages.login.tagline")}</p>
          <ul className="mt-4 hidden gap-2 text-body lg:grid">
            {benefits().map(b => (
              <li key={b} className="flex items-center gap-2">
                <Check className="h-4 w-4 shrink-0" aria-hidden />
                {b}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <main className="flex items-center justify-center py-4 lg:p-8">
        <div className="w-full max-w-md rounded-xl border bg-card p-6">
          <div className="mb-4 flex justify-end">
            <LanguagePicker />
          </div>
          <h1 className="text-heading font-semibold tracking-tight">{heading}</h1>
          {intro && <p className="mb-5 mt-1 text-body-sm text-muted-foreground">{intro}</p>}
          {children}
          {footer}
        </div>
      </main>
    </div>
  );
}

/** A form's error, read out when it appears. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-soft p-3 text-body-sm text-danger">
      {message}
    </p>
  );
}
