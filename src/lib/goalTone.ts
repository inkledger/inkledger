/** Fill tone of a goal bar: deeper once the goal is reached (never green). */
export function goalTone(pct: number): string {
  return pct >= 100 ? "bg-primary-strong" : "bg-primary";
}
