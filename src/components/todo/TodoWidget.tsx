import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { X } from "lucide-react";
import { todoFloat, todoFloatFocus } from "@/lib/flag";
import { todoFloatHidden, useTodoSurfacesNow } from "@/hooks/useTodoPanel";
import { lazyPart } from "@/components/app/lazyPart";
import { FloatingPanel } from "@/components/app/FloatingPanel";
import { floatRectSetting } from "@/lib/pinboardFloat";
import { TODO_SHAPE } from "@/lib/todoFloat";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { t } from "@/i18n";

const TodoList = lazyPart(() => import("@/components/todo/TodoList").then(m => m.TodoList));

const stored = floatRectSetting("ikl-todo-float");

/**
 * The TODO list over any page, like the pinboard's widget: floating, moved
 * and sized (kept per device), never a dialog; a sheet from the bottom on
 * small screens. It gives way on the list's own page.
 */
export function TodoWidget() {
  const open = todoFloat.useValue();
  const { pathname } = useLocation();
  const surfaces = useTodoSurfacesNow();
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  // On a phone the sheet is the way in (More, the header button) whatever the widget setting says.
  const shown = open && (surfaces.widget || !wide) && !todoFloatHidden(pathname);
  const close = () => todoFloat.set(false);

  if (!wide) {
    return (
      <Sheet open={shown} onOpenChange={todoFloat.set}>
        <SheetContent side="bottom" className="flex h-[85dvh] flex-col rounded-t-2xl p-3 pt-8">
          <SheetTitle className="sr-only">{t("views.todos.title")}</SheetTitle>
          <SheetDescription className="sr-only">{t("views.todos.description")}</SheetDescription>
          {shown && <TodoList className="min-h-0 flex-1" />}
        </SheetContent>
      </Sheet>
    );
  }
  return shown ? (
    <FloatingPanel
      marker="todo"
      label={t("ui.todoFloat.label")}
      strings={{ move: t("ui.todoFloat.move"), moveHint: t("ui.todoFloat.moveHint"), resize: t("ui.todoFloat.resize"), resizeHint: t("ui.todoFloat.resizeHint") }}
      stored={stored}
      shape={TODO_SHAPE}
      focus={todoFloatFocus}
      escapeFromFields
      onClose={close}
    >
      <div className="flex shrink-0 items-center justify-between px-3">
        <h2 className="font-display text-body font-semibold">{t("views.todos.title")}</h2>
        <Button variant="ghost" size="icon-sm" aria-label={t("ui.todoFloat.close")} title={t("ui.todoFloat.close")} onClick={close}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <TodoList className="min-h-0 flex-1 px-3 pb-3" />
    </FloatingPanel>
  ) : null;
}
