import { z } from "zod";
import { t } from "./i18n";
import { defaultWorkSchedule, minutesOf, type WorkSchedule } from "./workSchedule";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const hhmm = z.string().regex(HHMM, { error: () => t("server.workSchedule.invalidTime") });

const breakSchema = z.object({ start: hhmm, end: hhmm });

export const workDaySchema = z
  .object({
    enabled: z.boolean(),
    start: hhmm,
    end: hhmm,
    breaks: z.array(breakSchema).max(4),
  })
  .superRefine((d, ctx) => {
    if (!d.enabled) return;
    const start = minutesOf(d.start);
    const end = minutesOf(d.end);
    if (start >= end) {
      ctx.addIssue({ code: "custom", message: t("server.workSchedule.endAfterStart"), path: ["end"] });
      return;
    }
    let cursor = start;
    d.breaks.forEach((b, i) => {
      const bs = minutesOf(b.start);
      const be = minutesOf(b.end);
      if (bs >= be) {
        ctx.addIssue({ code: "custom", message: t("server.workSchedule.invalidBreak"), path: ["breaks", i] });
      } else if (bs < cursor || be > end) {
        ctx.addIssue({
          code: "custom",
          message: t("server.workSchedule.breaksOrder"),
          path: ["breaks", i],
        });
      }
      cursor = Math.max(cursor, be);
    });
  });

/** Monday first, like `startOfWeek`. */
export const workScheduleSchema = z.array(workDaySchema).length(7);

export type WorkDay = z.infer<typeof workDaySchema>;

/** A stored schedule, or the defaults when missing/invalid. */
export function normalizeWorkSchedule(raw: unknown): WorkSchedule {
  const parsed = workScheduleSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultWorkSchedule();
}
