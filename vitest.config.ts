import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "src"),
      "@db": path.resolve(templateRoot, "db"),
      "@contracts": path.resolve(templateRoot, "contracts"),
    },
  },
  test: {
    environment: "node",
    // Same zone as the Docker image: day/week boundaries and DST are tested in it.
    env: { TZ: "Europe/Rome" },
    // Shared code's own tests too (contracts/ runs on both sides), so none is skipped unseen.
    include: ["api/**/*.test.ts", "api/**/*.spec.ts", "src/**/*.test.ts", "contracts/**/*.test.ts"],
    setupFiles: ["api/test-setup.ts"],
    // CI runners are slower: booting the app and applying the migrations can
    // take several seconds there.
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
