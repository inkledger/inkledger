import { createRouter, publicQuery } from "./middleware";
import { authRouter } from "./routers/auth";
import { issuesRouter } from "./routers/issues";
import { worklogsRouter } from "./routers/worklogs";
import { statsRouter } from "./routers/stats";
import { timersRouter } from "./routers/timers";
import { settingsRouter } from "./routers/settings";
import { reportsRouter } from "./routers/reports";
import { outboxRouter } from "./routers/outbox";
import { weeksRouter } from "./routers/weeks";
import { notificationsRouter } from "./routers/notifications";
import { workScheduleRouter } from "./routers/workSchedule";
import { issueNotesRouter } from "./routers/issueNotes";
import { pinboardRouter } from "./routers/pinboard";
import { infoRouter } from "./routers/info";
import { backupRouter } from "./routers/backup";
import { modulesRouter } from "./routers/modules";
import { storeRouter } from "./routers/store";
import { usersRouter } from "./routers/users";
import { connectionsRouter } from "./routers/connections";
import { bucketsRouter } from "./routers/buckets";
import { clientsRouter } from "./routers/clients";
import { queriesRouter } from "./routers/queries";
import { sinksRouter } from "./routers/sinks";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  issues: issuesRouter,
  worklogs: worklogsRouter,
  stats: statsRouter,
  timers: timersRouter,
  settings: settingsRouter,
  reports: reportsRouter,
  outbox: outboxRouter,
  weeks: weeksRouter,
  notifications: notificationsRouter,
  workSchedule: workScheduleRouter,
  issueNotes: issueNotesRouter,
  pinboard: pinboardRouter,
  info: infoRouter,
  backup: backupRouter,
  modules: modulesRouter,
  store: storeRouter,
  users: usersRouter,
  connections: connectionsRouter,
  buckets: bucketsRouter,
  clients: clientsRouter,
  queries: queriesRouter,
  sinks: sinksRouter,
});

export type AppRouter = typeof appRouter;
