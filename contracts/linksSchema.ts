import { z } from "zod";
import { t } from "./i18n";
import { normalizeDomain } from "./links";

export const domainInput = z
  .string()
  .max(260)
  .transform((s, ctx) => {
    const d = normalizeDomain(s);
    if (!d) {
      ctx.addIssue({ code: "custom", message: t("server.links.invalidDomain", { domain: s }) });
      return z.NEVER;
    }
    return d;
  });
