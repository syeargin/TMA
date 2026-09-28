import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: true
  },
  // The site imports the shared role table from ../api/src/shared.
  server: { fs: { allow: [".."] } }
});
