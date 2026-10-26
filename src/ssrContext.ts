import type { QueryClient } from "@tanstack/react-query";
import type { trpc } from "@/lib/trpc";

export type SSRTRPCContext = {
  queryClient: QueryClient;
  trpcClient: ReturnType<typeof trpc.createClient>;
};
