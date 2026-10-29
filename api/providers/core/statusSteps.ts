// Status steps from a history where the status is one field: the adapter says
// which changes are of it and how a value names its status.
import { ProviderError } from "./errors";
import type { ChangeValue, RemoteChange, RemoteStatusStep } from "../types";

const step = (v: ChangeValue, idOf: (v: ChangeValue) => string | undefined) => {
  const id = idOf(v);
  // A status the answer doesn't name can't be placed: the history is not readable as statuses.
  if (!id) throw new ProviderError("incompatible", `a status change without the status's id ("${v.text}")`);
  return { id, name: v.text };
};

/** The changes of the status field, in the history's order; a value is placed by its id (by default ChangeValue.id). */
export function statusSteps(
  changes: readonly RemoteChange[],
  isStatus: (c: RemoteChange) => boolean,
  idOf: (v: ChangeValue) => string | undefined = (v) => v.id,
): RemoteStatusStep[] {
  return changes.filter(isStatus).flatMap((c) => {
    if (c.to.length !== 1 || c.from.length > 1) throw new ProviderError("incompatible", `a status change from ${c.from.length} to ${c.to.length} values`);
    const to = step(c.to[0], idOf);
    const from = c.from.length ? step(c.from[0], idOf) : null;
    return from?.id === to.id ? [] : [{ at: c.at, from, to }];
  });
}
