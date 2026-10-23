import devServer from "@hono/vite-dev-server"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

/** The build's id in the page (contracts/appBuild.ts): only on a real build, so dev never asks to reload. */
function appBuild(): Plugin {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return {
    name: "app-build",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { name: "app-build", content: id }, injectTo: "head" }],
  }
}

/**
 * Dev only: a new migration (drizzle/meta/_journal.json changed) is applied at
 * once to the dev database. The API module stays loaded across edits, and its
 * database migrates only when first opened, so without this a new table only
 * came with a restart (and the pages failed on it meanwhile).
 */
function migrateOnNewMigration(): Plugin {
  return {
    name: "migrate-on-new-migration",
    apply: "serve",
    configureServer(server) {
      const journal = path.resolve(__dirname, "drizzle/meta/_journal.json")
      server.watcher.add(journal)
      server.watcher.on("change", file => {
        if (path.resolve(file) !== journal) return
        void server
          .ssrLoadModule("/api/queries/connection.ts")
          .then(m => (m as { migrateDb: () => Promise<void> }).migrateDb())
          .then(
            () => server.config.logger.info("[db] new migrations applied"),
            (e: unknown) => server.config.logger.error(`[db] migrating failed: ${String(e)}`)
          )
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/).*$/] }),
    react(),
    appBuild(),
    migrateOnNewMigration()],
  server: {
    port: 3000,
    // IPv4 loopback: what `tailscale serve` and the native app point at.
    host: "127.0.0.1",
    // Reached over the tailnet or the LAN too (the server checks hosts itself).
    allowedHosts: [".ts.net", ".local"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      "db": path.resolve(__dirname, "./db"),
    },
  },
  envDir: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
  },
});
