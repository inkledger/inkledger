// Server maintenance from a shell, for when nobody can sign in:
//   node dist/cli.js reset-password <username>    (in Docker: docker exec inkledger node dist/cli.js …)
//   pnpm user:reset <username>                     (from the repo)
// Prints a temporary password; the account must change it at its next
// sign-in, and is signed out everywhere.
//   node dist/cli.js closures-from <username|user id> <module> <YYYY-MM-DD>
// The module hears the issues closed from that day on that it was not told
// yet (a catch-up through its own rules), never before it started counting.
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

async function closuresFrom(username: string | undefined, moduleId: string | undefined, day: string | undefined) {
  const usage = "usage: closures-from <username|user id> <module> <YYYY-MM-DD>";
  if (!username || !moduleIdSchema.safeParse(moduleId).success || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) throw new Error(usage);
  // A tracker sign-in may have no username: its id then.
  const user = /^\d+$/.test(username) ? (await getDb().select().from(users).where(eq(users.id, Number(username))))[0] : await userByUsername(username);
  if (!user) throw new Error(`no account "${username}"`);
  // The server's zone is the user's (lib/tz): the day starts at its local midnight.
  const from = new Date(`${day}T00:00:00`).getTime();
  if (!Number.isFinite(from)) throw new Error(usage);
  const { total, high } = await releaseClosuresFrom(user, String(moduleId), from);
  console.log(`${moduleId} hears ${total} closure(s) assigned to ${username} from ${day} not told yet (${high} high priority), not before it started counting, once it runs.`);
}

const [command, ...args] = process.argv.slice(2);
try {
  await initDb();
  if (command === "reset-password") await resetPassword(args[0]);
  else if (command === "closures-from") await closuresFrom(args[0], args[1], args[2]);
  else throw new Error("commands: reset-password <username> | closures-from <username|user id> <module> <YYYY-MM-DD>");
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await closeDb();
}
