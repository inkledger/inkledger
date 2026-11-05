import { addDays, dayKey } from "@contracts/time";

export type Due = "none" | "today" | "tomorrow" | "pick";

/** The due day a choice stands for (`today` is the caller's: its clock, or the click's instant). */
export const dueOnOf = (due: Due, picked: string, today: Date): string | null =>
  due === "today" ? dayKey(today) : due === "tomorrow" ? dayKey(addDays(today, 1)) : due === "pick" ? picked || null : null;
