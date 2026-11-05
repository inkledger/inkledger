/** Whether every one of `ids` is selected (vacuously true for none). */
export const allSelected = (ids: readonly number[], selected: ReadonlySet<number>): boolean => ids.every(id => selected.has(id));

/** A group checkbox's state: all of `ids` selected, some, or none. */
export const selectionOf = (ids: readonly number[], selected: ReadonlySet<number>): boolean | "indeterminate" =>
  allSelected(ids, selected) ? true : ids.some(id => selected.has(id)) ? "indeterminate" : false;
