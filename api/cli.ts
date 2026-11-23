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
import "./lib/tz";
import { eq } from "drizzle-orm";
import { users } from "@db/schema";
import { closeDb, getDb, initDb } from "./queries/connection";
import { signOutEverywhere, userByUsername } from "./queries/accounts";
import { releaseClosuresFrom } from "./modules/closures";
import { moduleIdSchema } from "@contracts/modulesSchema";
import { hashPassword, temporaryPassword } from "./lib/password";

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

const [command, ...args] = process.argv.slice(2);
try {
  await initDb();
  if (command === "reset-password") await resetPassword(args[0]);
  else if (command === "closures-from") await closuresFrom(args);
  else throw new Error("commands: reset-password <username> | closures-from <username|user id> <module> <YYYY-MM-DD> [--already <n>] [--apply]");
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await closeDb();
}
