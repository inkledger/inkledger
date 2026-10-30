// Where each project's code is on the user's computer (contracts/analyze.ts):
// only kept to be put in the "Analyse" command, never read or opened here.
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { connections, containerPaths, containers } from "@db/schema";
import { isRepoPath } from "@contracts/analyze";
import { t } from "@contracts/i18n";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";

export const REPO_PATHS_MAX = 10;

const repo = z.object({
  label: z.string().trim().max(60),
  path: z.string().trim().refine(isRepoPath, { message: t("server.projectPaths.badPath") }),
});

/** The paths of a project, in order (empty when none). */
export async function pathsOf(userId: number, containerId: number) {
  return getDb()
    .select({ label: containerPaths.label, path: containerPaths.path })
    .from(containerPaths)
    .where(and(eq(containerPaths.userId, userId), eq(containerPaths.containerId, containerId)))
    .orderBy(asc(containerPaths.position));
}

export const projectPathsRouter = createRouter({
  /** Every project of the user's connections in use, with its paths. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const [projects, paths] = await Promise.all([
      db
        .select({ id: containers.id, key: containers.key, name: containers.name, connection: connections.label })
        .from(containers)
        .innerJoin(connections, eq(connections.id, containers.connectionId))
        .where(and(eq(connections.userId, ctx.user.id), isNull(connections.archivedAt)))
        .orderBy(asc(containers.key))
        .limit(500),
      db
        .select({ containerId: containerPaths.containerId, label: containerPaths.label, path: containerPaths.path })
        .from(containerPaths)
        .where(eq(containerPaths.userId, ctx.user.id))
        .orderBy(asc(containerPaths.position)),
    ]);
    return projects.map((p) => ({ ...p, paths: paths.filter((x) => x.containerId === p.id).map(({ label, path }) => ({ label, path })) }));
  }),

  /** A project's paths, all at once (the order is the list's; the first is where the agent starts). */
  save: protectedProcedure
    .input(z.object({ containerId: z.number().int().positive(), paths: z.array(repo).max(REPO_PATHS_MAX) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [own] = await db
        .select({ id: containers.id })
        .from(containers)
        .innerJoin(connections, eq(connections.id, containers.connectionId))
        .where(and(eq(containers.id, input.containerId), eq(connections.userId, ctx.user.id), isNull(connections.archivedAt)))
        .limit(1);
      if (!own) throw new TRPCError({ code: "NOT_FOUND", message: t("server.ideas.noContainer") });
      const unique = input.paths.filter((p, i) => input.paths.findIndex((q) => q.path === p.path) === i);
      await db.transaction(async (tx) => {
        await tx.delete(containerPaths).where(and(eq(containerPaths.userId, ctx.user.id), eq(containerPaths.containerId, input.containerId)));
        if (unique.length)
          await tx.insert(containerPaths).values(unique.map((p, position) => ({ userId: ctx.user.id, containerId: input.containerId, label: p.label, path: p.path, position })));
      });
      return pathsOf(ctx.user.id, input.containerId);
    }),
});
