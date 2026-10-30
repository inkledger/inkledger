// A transition's fields before it reaches an adapter: whether inkledger can carry
// it out at all, and whether the values given fit what it asks for.
import { ProviderError } from "./errors";
import type { FieldReq, FieldValue, Transition } from "../types";

/** inkledger can fill them: no required field of a type it doesn't know. */
export const fillable = (requirements: readonly FieldReq[]) => !requirements.some((r) => r.required && r.type === "unknown");

/** inkledger can carry it out: no required field of a type it doesn't know. */
export const executable = (t: Transition) => fillable(t.requirements);

function fits(req: FieldReq, v: FieldValue): boolean {
  switch (req.type) {
    case "text":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "date":
      return typeof v === "object" && v !== null && "date" in v;
    case "user":
      return typeof v === "object" && v !== null && "user" in v;
    case "choice":
      return typeof v === "string" && req.options.some((o) => o.id === v);
    case "multiChoice":
      return Array.isArray(v) && v.every((x) => req.options.some((o) => o.id === x));
    case "unknown":
      return false;
  }
}

/** Throws "invalid" (with the fields at fault) unless `values` fill `requirements`, and nothing else. */
export function assertFields(what: string, requirements: readonly FieldReq[], values: Record<string, FieldValue>): void {
  if (!fillable(requirements)) throw new ProviderError("invalid", `"${what}" asks for a field inkledger can't fill: complete it on the service`);
  const fields: Record<string, string> = {};
  for (const r of requirements) {
    const v = values[r.id];
    if (v === undefined) {
      if (r.required) fields[r.id] = "required";
    } else if (!fits(r, v)) fields[r.id] = `not a ${r.type}`;
  }
  for (const id of Object.keys(values)) if (!requirements.some((r) => r.id === id)) fields[id] = "not asked for";
  if (Object.keys(fields).length > 0) throw new ProviderError("invalid", `Fields don't fit "${what}"`, { fields });
}

/** Throws "invalid" (with the fields at fault) unless `values` fill `t`'s requirements, and nothing else. */
export function assertTransitionFields(t: Transition, values: Record<string, FieldValue>): void {
  assertFields(t.name, t.requirements, values);
}
