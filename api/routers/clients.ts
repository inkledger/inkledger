// Clients (§4.7): who the work is for, across trackers. A client gathers
// containers (projects, repositories) of the user's connections; searches
// (client:), buckets and reports read it. Suggested from the trackers' own
// groups (a Jira project category, a GitHub owner), never made unasked.
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { clientContainers, clients, connections, containers } from "@db/schema";
import { t } from "@contracts/i18n";
import { createRouter, protectedProcedure } from "../middleware";
import { getDb } from "../queries/connection";
import { ensureContainer } from "../queries/containers";
import { boundTracker } from "../sync/engine";
import { providerCall } from "../providers/trpc";

const name = z.string().trim().min(1).max(80);

/** The user's live connections' containers, with the client each belongs to. */
async function userContainers(userId: number) {
  return getDb()
    .select({
      id: containers.id,
      key: containers.key,
      name: containers.name,
      group: containers.groupName,
      connectionId: containers.connectionId,
      clientId: clientContainers.clientId,
    })
    .from(containers)
    .innerJoin(connections, eq(connections.id, containers.connectionId))
    .leftJoin(clientContainers, eq(clientContainers.containerId, containers.id))
    .where(and(eq(connections.userId, userId), isNull(connections.archivedAt)))
    .orderBy(asc(containers.key));
}

const parseAliases = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
};

export const clientsRouter = createRouter({
  /** The user's clients with their containers, and every container to choose from. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getDb().select().from(clients).where(eq(clients.userId, ctx.user.id)).orderBy(asc(clients.name));
    const boxes = await userContainers(ctx.user.id);
    return {
      clients: rows.map((c) => ({ id: c.id, name: c.name, aliases: parseAliases(c.aliases), color: c.color, containerIds: boxes.filter((b) => b.clientId === c.id).map((b) => b.id) })),
      containers: boxes,
    };
  }),

  /**
   * Clients the trackers suggest: each group of containers (a project
   * category, an owner) that isn't a client yet. Reads every connection's
   * containers again, so groups are fresh.
   */
  suggestions: protectedProcedure.query(async ({ ctx }) => {
    const conns = await getDb()
      .select()
      .from(connections)
      .where(and(eq(connections.userId, ctx.user.id), isNull(connections.archivedAt)));
    for (const conn of conns) {
      const b = boundTracker(conn);
      if (!b?.containers) continue;
      try {
        const list = await providerCall(() => b.containers!({ signal: AbortSignal.timeout(30_000), correlationId: `clients-${conn.id}` }));
        for (const c of list) await ensureContainer(conn.id, c);
      } catch (e) {
        // A tracker that doesn't answer suggests from what is known.
        console.warn(`[clients] ${conn.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const taken = new Set((await getDb().select({ name: clients.name }).from(clients).where(eq(clients.userId, ctx.user.id))).map((c) => c.name.toLowerCase()));
    const groups = new Map<string, number[]>();
    for (const b of await userContainers(ctx.user.id)) {
      if (!b.group || b.clientId !== null || taken.has(b.group.toLowerCase())) continue;
      groups.set(b.group, [...(groups.get(b.group) ?? []), b.id]);
    }
    return [...groups].map(([group, containerIds]) => ({ name: group, containerIds })).sort((a, b) => a.name.localeCompare(b.name));
  }),

  /** A client made or changed, with exactly these containers (taken from another client when needed). */
  save: protectedProcedure
    .input(z.object({ id: z.number().int().positive().optional(), name, aliases: z.array(name).max(20).default([]), color: z.string().max(40).default(""), containerIds: z.array(z.number().int().positive()).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      const own = new Set((await userContainers(ctx.user.id)).map((b) => b.id));
      if (input.containerIds.some((id) => !own.has(id))) throw new TRPCError({ code: "BAD_REQUEST", message: t("server.clients.badContainer") });
      return getDb().transaction(async (tx) => {
        const values = { name: input.name, aliases: JSON.stringify(input.aliases), color: input.color };
        let id = input.id;
        if (id !== undefined) {
          const [mine] = await tx.update(clients).set(values).where(and(eq(clients.id, id), eq(clients.userId, ctx.user.id))).returning({ id: clients.id });
          if (!mine) throw new TRPCError({ code: "NOT_FOUND" });
        } else {
          id = (await tx.insert(clients).values({ userId: ctx.user.id, ...values }).returning({ id: clients.id }))[0].id;
        }
        await tx.delete(clientContainers).where(and(eq(clientContainers.clientId, id), input.containerIds.length ? notInArray(clientContainers.containerId, input.containerIds) : undefined));
        if (input.containerIds.length) {
          // A container is one client's: moved here from any other.
          await tx.delete(clientContainers).where(inArray(clientContainers.containerId, input.containerIds));
          await tx.insert(clientContainers).values(input.containerIds.map((containerId) => ({ clientId: id, containerId })));
        }
        return { id };
      });
    }),

  delete: protectedProcedure.input(z.object({ id: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
    const gone = await getDb().delete(clients).where(and(eq(clients.id, input.id), eq(clients.userId, ctx.user.id))).returning({ id: clients.id });
    if (gone.length === 0) throw new TRPCError({ code: "NOT_FOUND" });
    return { ok: true };
  }),
});
