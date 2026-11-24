// Server maintenance from a shell, for when nobody can sign in:
//   node dist/cli.js reset-password <username>    (in Docker: docker exec inkledger node dist/cli.js …)
//   pnpm user:reset <username>                     (from the repo)
// Prints a temporary password; the account must change it at its next
// sign-in, and is signed out everywhere.
//   node dist/cli.js closures-from <username|user id> <module> <YYYY-MM-DD> [--already <n>] [--apply]
// The module hears the issues assigned to the user closed from that day on
// that it was not told yet (a catch-up through its own rules), never before
// it started counting. --already: closures it counted live before, skipped
// (the most recent plain ones). A dry run unless --apply.
//   node dist/cli.js keys-status
// Per sealed column, how many values open with CREDENTIALS_KEY, CREDENTIALS_KEY_OLD,
// the key derived from SESSION_SECRET, or none; warns before a key may change.
//   node dist/cli.js reseal [--apply]
// Seals every value that opens again with the current key and lists the rows
// none opens (table, column, row id). A dry run unless --apply.
// Neither seals anything at start (the server does that for connections at boot).
//   node dist/cli.js decrypt-backup <copy.enc> <out>
// Opens an off-site copy (S3) with BACKUP_KEY or BACKUP_KEY_OLD from the environment,
// writing <out> only once every byte has verified. Needs no database: for a server
// that can't start (docs/it/runbook-restore.md).
import "./lib/tz";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { users } from "@db/schema";
import { closeDb, getDb, initDb } from "./queries/connection";
import { signOutEverywhere, userByUsername } from "./queries/accounts";
import { releaseClosuresFrom } from "./modules/closures";
import { moduleIdSchema } from "@contracts/modulesSchema";
import { hashPassword, temporaryPassword } from "./lib/password";
import { keysStatus, resealAll } from "./queries/sealedValues";
import { decryptToFile } from "./backupCrypto";

async function decryptBackup([from, to]: string[]) {
  if (!from || !to) throw new Error("usage: decrypt-backup <copy.enc> <out>");
  if (fs.existsSync(to)) throw new Error(`${to} exists: give a new file name`);
  await decryptToFile(fs.createReadStream(from), to);
  console.log(`Decrypted into ${to}`);
}

async function resetPassword(username: string | undefined) {
  if (!username) throw new Error("usage: reset-password <username>");
  const user = await userByUsername(username);
  if (!user) throw new Error(`no account "${username}"`);
  const password = temporaryPassword();
  await getDb()
    .update(users)
    .set({ passwordHash: await hashPassword(password), mustChangePassword: 1, disabledAt: null })
    .where(eq(users.id, user.id));
  await signOutEverywhere(user.id);
  console.log(`Temporary password for "${user.username}": ${password}\nIt must be changed at the next sign-in.`);
  if (user.disabledAt) console.log("The account was turned off: it is on again (turn it off in Settings › Users if that is not what you meant).");
}

async function closuresFrom(rest: string[]) {
  const usage = "usage: closures-from <username|user id> <module> <YYYY-MM-DD> [--already <n>] [--apply]";
  const apply = rest.includes("--apply");
  const at = rest.indexOf("--already");
  const already = at >= 0 ? Number(rest[at + 1]) : 0;
  const [username, moduleId, day] = rest.filter((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
  if (!username || !moduleIdSchema.safeParse(moduleId).success || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? "") || !Number.isInteger(already) || already < 0) throw new Error(usage);
  // A tracker sign-in may have no username: its id then.
  const user = /^\d+$/.test(username) ? (await getDb().select().from(users).where(eq(users.id, Number(username))))[0] : await userByUsername(username);
  if (!user) throw new Error(`no account "${username}"`);
  // The server's zone is the user's (lib/tz): the day starts at its local midnight.
  const from = new Date(`${day}T00:00:00`).getTime();
  if (!Number.isFinite(from)) throw new Error(usage);
  const r = await releaseClosuresFrom(user, String(moduleId), from, { already, apply });
  console.log(`${moduleId}, closures assigned to ${username} from ${day} not told yet: delivers ${r.deliver} (${r.golden} golden), skips ${r.skipped.length} counted live${r.skipped.length ? `: ${r.skipped.map((c) => c.issueKey).join(", ")}` : ""}.`);
  if (r.skipped.length < already) console.log(`Only ${r.skipped.length} plain closure(s) to skip, ${already} asked.`);
  console.log(r.applied ? "Applied: the module hears them the next time it runs." : "Dry run: nothing written (add --apply).");
}

async function printKeysStatus() {
  const s = await keysStatus(getDb());
  console.log(`New values are sealed with: ${s.sealingKey}`);
  for (const c of s.columns) {
    console.log(`${c.column}: ${c.total} value(s); CREDENTIALS_KEY ${c.CREDENTIALS_KEY}, CREDENTIALS_KEY_OLD ${c.CREDENTIALS_KEY_OLD}, SESSION_SECRET ${c.SESSION_SECRET}, unreadable ${c.unreadable}`);
  }
  for (const w of s.warnings) console.log(`Warning: ${w}`);
  if (s.warnings.length === 0) console.log("Nothing depends on SESSION_SECRET or CREDENTIALS_KEY_OLD.");
}

async function reseal(rest: string[]) {
  const apply = rest.includes("--apply");
  const r = await resealAll(getDb(), { apply });
  console.log(`Current key: ${r.sealingKey}`);
  for (const c of r.columns) {
    const verb = r.applied ? "sealed again" : "to seal again";
    console.log(`${c.column}: ${c.current} already current, ${c.resealed} ${verb}${c.changed ? `, ${c.changed} changed meanwhile (run again)` : ""}, ${c.unreadable.length} unreadable`);
    if (c.unreadable.length) console.log(`  unreadable row ids: ${c.unreadable.join(", ")}`);
  }
  console.log(r.applied ? "Applied." : "Dry run: nothing written (add --apply).");
  if (r.columns.some((c) => c.unreadable.length > 0)) process.exitCode = 2;
}

const COMMANDS =
  "commands: reset-password <username> | closures-from <username|user id> <module> <YYYY-MM-DD> [--already <n>] [--apply] | keys-status | reseal [--apply] | decrypt-backup <copy.enc> <out>";

const [command, ...args] = process.argv.slice(2);
try {
  // Off-site copies open without a database (a server that can't start).
  if (command === "decrypt-backup") await decryptBackup(args);
  else {
    // Looking at the keys must not change what it looks at: no seal at start for these.
    await initDb({ reseal: command !== "keys-status" && command !== "reseal" });
    if (command === "reset-password") await resetPassword(args[0]);
    else if (command === "closures-from") await closuresFrom(args);
    else if (command === "keys-status") await printKeysStatus();
    else if (command === "reseal") await reseal(args);
    else throw new Error(COMMANDS);
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await closeDb();
}
