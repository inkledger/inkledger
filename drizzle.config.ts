import { defineConfig } from "drizzle-kit";

/** Migrations from db/schema.ts: `pnpm db:generate`, applied at server start. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./drizzle",
});
