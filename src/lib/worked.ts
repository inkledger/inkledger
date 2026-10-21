import { realSecondsByDay, realSecondsTotal } from "@contracts/placement";

type Logged = { started: string | Date; timeSpentSeconds: number };

const blocks = (logs: readonly Logged[]) => logs.map(w => ({ start: new Date(w.started), seconds: w.timeSpentSeconds }));

/** The hours worked in these worklogs: parallel work once, day by day (realSeconds). */
export const workedSeconds = (logs: readonly Logged[]) => realSecondsTotal(blocks(logs));

/** The hours worked each local day ("YYYY-MM-DD"). */
export const workedByDay = (logs: readonly Logged[]) => realSecondsByDay(blocks(logs));
