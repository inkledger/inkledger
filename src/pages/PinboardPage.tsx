import { PageHeader } from "@/components/app/PageHeader";
import { PanelSection } from "@/components/app/Panel";
import { Pinboard } from "@/components/board/Pinboard";
import { t } from "@/i18n";

/** The pinboard as a page of its own (Settings → Pinboard → in the menu): the whole panel, nothing to close. */
export default function PinboardPage() {
  return (
    <div data-fill-page className="flex flex-col lg:min-h-0 lg:flex-1">
      <PageHeader title={t("pages.board.pinboard")} description={t("pages.board.pinboardDescription")} />
      <PanelSection className="flex min-h-[70dvh] flex-1 flex-col lg:min-h-0">
        <Pinboard className="min-h-0 flex-1" resizable={false} closable={false} />
      </PanelSection>
    </div>
  );
}
