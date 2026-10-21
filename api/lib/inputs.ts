import { z } from "zod";
import { ISSUE_KEY_RE } from "../jira/client";
import { t } from "@contracts/i18n";

/** A key shaped like a repository's issue: owner/repo#12 (GitHub, Gitea), case kept. */
export const REPO_KEY_RE = /^[A-Za-z0-9][\w.-]{0,99}\/[\w.-]{1,100}#\d{1,9}$/;

/**
 * An issue key as typed by the user, trimmed: a project key (APP-12,
 * upper-cased: Jira's are) or a repository's (owner/repo#12, as written).
 */
export const issueKeyInput = z
  .string()
  .trim()
  .transform((k) => (REPO_KEY_RE.test(k) ? k : k.toUpperCase()))
  .pipe(z.string().refine((k) => ISSUE_KEY_RE.test(k) || REPO_KEY_RE.test(k), { error: () => t("server.issues.invalidKey") }));

/** Safety cap on unpaginated lists: years of daily use stay well below it. */
export const LIST_MAX_ROWS = 5000;
