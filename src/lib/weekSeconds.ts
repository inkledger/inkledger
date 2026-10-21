import { addDays } from "@contracts/time";
import { expectedSeconds, type WorkSchedule } from "@contracts/workSchedule";

/** Expected seconds of a whole week with this schedule. */
export function weekSeconds(schedule: WorkSchedule, monday: Date): number {
  let total = 0;
  for (let i = 0; i < 7; i++)
    total += expectedSeconds(addDays(monday, i), schedule);
  return total;
}
