/**
 * Vite build for the Hacker News extension's client.
 *
 * Small and dependency-free, so it stays a **single bundle in a directory**
 * (`suwu.static: "dist"`) rather than a `dist.zip` — the archive exists to keep
 * a many-chunk extension (excalidraw) to one file, and this one has nothing to
 * gain from it. `inlineDynamicImports` gives exactly one JS file: there are no
 * dynamic imports and no workers here.
 *
 * The render stub (index.js) reads Vite's manifest off disk to inject the hashed
 * script — possible because a directory static source can be read through the
 * extension mount, unlike an archive.
 */
import { defineConfig } from "vite";
import { join } from "node:path";

export default defineConfig({
  root: __dirname,
  publicDir: false,
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    manifest: true,
    sourcemap: false,
    rollupOptions: {
      input: join(__dirname, "src", "main.js"),
      output: {
        inlineDynamicImports: true,
        entryFileNames: "app-[hash].js",
        assetFileNames: "[name]-[hash][extname]",
      },
    },
  },
});
