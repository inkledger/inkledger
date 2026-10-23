import { PageHeader } from "@/components/app/PageHeader";
import { PanelSection } from "@/components/app/Panel";
import { TodoList } from "@/components/todo/TodoList";
import { t } from "@/i18n";

/** The TODO list as a page of its own (Settings → TODO → in the menu). */
export default function TodosPage() {
  return (
    <div data-fill-page className="flex flex-col lg:min-h-0 lg:flex-1">
      <PageHeader title={t("views.todos.title")} description={t("views.todos.description")} />
      <PanelSection className="flex min-h-[70dvh] flex-1 flex-col lg:min-h-0">
        <TodoList className="mx-auto min-h-0 w-full max-w-2xl flex-1" />
      </PanelSection>
    </div>
  );
}
