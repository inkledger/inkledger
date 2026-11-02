// A connection's options as an adapter reads them: its schema, refused in the
// layer's words.
import type { z } from "zod";
import { ProviderError } from "./errors";

/** A parseOptions: `raw` (none: the defaults) read with `schema`, refused as "invalid" with the schema's messages. */
export const optionsParser =
  <S extends z.ZodType>(name: string, schema: S) =>
  (raw: unknown): z.output<S> => {
    const r = schema.safeParse(raw ?? {});
    if (!r.success) throw new ProviderError("invalid", `${name} options: ${r.error.issues.map((i) => i.message).join("; ")}`);
    return r.data;
  };
