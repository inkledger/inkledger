import { defineConfig } from "vite";
import base from "./vite.config";

export default defineConfig({
  ...base,
  build: {
    ...base.build,
    outDir: "dist/ssr",
    emptyOutDir: true,
    ssr: "src/entry-server.tsx",
  },
  ssr: {
    noExternal: true,
  },
});
