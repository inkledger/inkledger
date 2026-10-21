import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

/** The undismissed notifications, with optimistic dismiss / dismiss all. */
export function useNotificationList() {
  const utils = trpc.useUtils();
  const list = trpc.notifications.list.useQuery(undefined, {
    refetchInterval: 60_000,
  });
  const refresh = () => {
    void utils.notifications.list.invalidate();
    void utils.notifications.count.invalidate();
  };
  const onError = (e: { message: string }) => {
    toast.error(e.message);
    refresh();
  };
  const dismiss = trpc.notifications.dismiss.useMutation({
    onMutate: async ({ id }) => {
      await utils.notifications.list.cancel();
      utils.notifications.list.setData(undefined, old =>
        old?.filter(n => n.id !== id)
      );
    },
    onError,
    onSettled: refresh,
  });
  const dismissAll = trpc.notifications.dismissAll.useMutation({
    onMutate: async () => {
      await utils.notifications.list.cancel();
      utils.notifications.list.setData(undefined, []);
    },
    onError,
    onSettled: refresh,
  });
  return {
    query: list,
    items: list.data ?? [],
    dismiss: (id: number) => dismiss.mutate({ id }),
    dismissAll: () => dismissAll.mutate(),
  };
}
