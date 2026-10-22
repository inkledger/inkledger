import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsGroup";
import { FollowTagDialog } from "@/components/board/FollowTagDialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { usePinboardSurfaces } from "@/hooks/usePinboardPanel";
import { toastError } from "@/lib/errorText";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";

/**
 * Where the pinboard lives: the Board's panel, its page in the menu, the
 * floating widget ("p"), each on or off; and the boards that follow a tag.
 */
export function PinboardSection() {
  const utils = trpc.useUtils();
  const s = usePinboardSurfaces();
  const save = trpc.settings.update.useMutation({ onSuccess: data => utils.settings.get.setData(undefined, data) });
  const rows = [
    { key: "pinboardOnBoard", on: s.board, label: t("settings.pinboard.onBoard"), hint: t("settings.pinboard.onBoardHint") },
    { key: "pinboardInMenu", on: s.menu, label: t("settings.pinboard.inMenu"), hint: t("settings.pinboard.inMenuHint") },
    { key: "pinboardWidget", on: s.widget, label: t("settings.pinboard.widget"), hint: t("settings.pinboard.widgetHint") },
  ] as const;
  return (
    <>
      <SettingsGroup id="pinboard-places" title={t("settings.pinboard.placesTitle")} keywords={t("settings.pinboard.placesKeywords")}>
        {rows.map(r => (
          <SettingsRow key={r.key} label={r.label} hint={r.hint}>
            <Switch aria-label={r.label} checked={r.on} disabled={save.isPending} onCheckedChange={v => save.mutate({ [r.key]: v })} />
          </SettingsRow>
        ))}
      </SettingsGroup>
      <FollowedBoards />
    </>
  );
}

/** The boards that follow a tag: each with what it follows and how many open issues it shows; add one, remove one. */
function FollowedBoards() {
  const utils = trpc.useUtils();
  const boards = trpc.pinboard.boards.useQuery();
  const [picking, setPicking] = useState(false);
  const followed = (boards.data ?? []).filter(b => b.follow);
  const refresh = () => utils.pinboard.invalidate();
  return (
    <SettingsGroup
      id="pinboard-follow"
      title={t("settings.pinboard.followTitle")}
      description={t("settings.pinboard.followHint")}
      keywords={t("settings.pinboard.followKeywords")}
      actions={
        <Button variant="outline" size="sm" onClick={() => setPicking(true)}>
          <Plus className="h-4 w-4" /> {t("views.board.pinboard.followTag")}
        </Button>
      }
    >
      {followed.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">{t("settings.pinboard.followNone")}</p>
      ) : (
        followed.map(b => (
          <SettingsRow
            key={b.id}
            label={b.name}
            hint={t(b.follow?.field === "component" ? "views.board.pinboard.followsComponent" : "views.board.pinboard.followsLabel", { value: b.follow?.value ?? "" })}
          >
            <span className="text-caption text-muted-foreground tabular">{b.count}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("settings.pinboard.followRemove", { name: b.name })}
              title={t("settings.pinboard.followRemove", { name: b.name })}
              onClick={() =>
                void utils.client.pinboard.deleteBoard.mutate({ id: b.id }).then(() => {
                  toast.success(t("views.board.pinboard.deleted", { name: b.name }));
                  return refresh();
                }, toastError)
              }
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </SettingsRow>
        ))
      )}
      <FollowTagDialog
        open={picking}
        onClose={() => setPicking(false)}
        onPick={tag =>
          utils.client.pinboard.createBoard.mutate({ name: tag.value.slice(0, 60), follow: tag }).then(() => {
            setPicking(false);
            toast.success(t("views.board.pinboard.created", { name: tag.value }));
            return refresh();
          }, toastError)
        }
      />
    </SettingsGroup>
  );
}
