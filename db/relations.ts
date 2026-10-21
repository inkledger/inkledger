import { relations } from "drizzle-orm";
import { users, sessions, issues, worklogs, timers } from "./schema";

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  issues: many(issues),
  worklogs: many(worklogs),
  timers: many(timers),
}));

export const timersRelations = relations(timers, ({ one }) => ({
  user: one(users, { fields: [timers.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const issuesRelations = relations(issues, ({ one }) => ({
  user: one(users, { fields: [issues.userId], references: [users.id] }),
}));

export const worklogsRelations = relations(worklogs, ({ one }) => ({
  user: one(users, { fields: [worklogs.userId], references: [users.id] }),
}));
