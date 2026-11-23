import { useTodoSurfacesNow } from "@/hooks/useTodoPanel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  shortcuts,
  shortcutsHelp,
  useShortcutsHelpOpen,
} from "@/lib/shortcuts";
import { Kbd } from "@/components/app/Kbd";
import { usePinboardSurfacesNow } from "@/hooks/usePinboardPanel";
import { SectionLabel } from "@/components/app/PageHeader";
import { t, useLocale } from "@/i18n";
import { useRunningCommands } from "@/modules/commands";

/** "?" help: every keyboard shortcut, grouped. */
export function ShortcutsDialog() {
  const open = useShortcutsHelpOpen();
  const { board, menu, widget } = usePinboardSurfacesNow();
  const todos = useTodoSurfacesNow();
  const lang = useLocale() === "it" ? "it" : "en";
  const modules = useRunningCommands().map(c => ({ keys: c.keys, label: c.label[lang], module: c.moduleName[lang] }));
  return (
    <Dialog open={open} onOpenChange={shortcutsHelp.set}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ui.shortcuts.title")}</DialogTitle>
          <DialogDescription>
            {t("ui.shortcuts.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {shortcuts({ pinboard: board || menu || widget, todos: todos.widget || todos.menu, modules }).map(({ group, items }) => (
            <section key={group}>
              <SectionLabel as="h3" className="mb-2 px-0">
                {group}
              </SectionLabel>
              <dl className="grid gap-1.5">
                {items.map(({ keys, label }) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-4 text-body-sm"
                  >
                    <dt>{label}</dt>
                    <dd className="flex shrink-0 gap-1">
                      {keys.map(k => (
                        <Kbd key={k} size="lg">
                          {k}
                        </Kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
