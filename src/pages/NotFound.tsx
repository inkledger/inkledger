import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/States";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { t } from "@/i18n";

export default function NotFound() {
  useDocumentTitle(t("pages.notFound.title"));
  return (
    <div className="flex flex-col items-center py-16">
      <EmptyState
        art="search"
        title={t("pages.notFound.title")}
        message={t("pages.notFound.message")}
        action={
          <Button asChild>
            <Link to="/">{t("pages.notFound.back")}</Link>
          </Button>
        }
      />
    </div>
  );
}
