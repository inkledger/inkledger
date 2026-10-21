// Server maintenance from a shell, for when nobody can sign in:
//   node dist/cli.js reset-password <username>    (in Docker: docker exec inkledger node dist/cli.js …)
//   pnpm user:reset <username>                     (from the repo)
// Prints a temporary password; the account must change it at its next
// sign-in, and is signed out everywhere.
import "./lib/tz";
import { eq } from "drizzle-orm";
import { users } from "@db/schema";
import { closeDb, getDb, initDb } from "./queries/connection";
import { signOutEverywhere, userByUsername } from "./queries/accounts";
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
}

const [command, ...args] = process.argv.slice(2);
await initDb();
try {
  if (command === "reset-password") await resetPassword(args[0]);
  else throw new Error("commands: reset-password <username>");
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await closeDb();
}
