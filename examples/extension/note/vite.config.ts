/**
 * Vite build for the Note extension's client.
 *
 * A self-contained, dependency-free app, so it stays a **single bundle in a
 * directory** (`suwu.static: "dist"`) rather than a `dist.zip`: the archive is
 * for an extension with many chunks (excalidraw), and this one gains nothing
 * from it. `inlineDynamicImports` is safe here — no dynamic imports, no workers.
 *
 * Only `src/` is build input; `test/` keeps running the source modules directly
 * with `node --test`.
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
        entryFileNames: "note-[hash].js",
        assetFileNames: "[name]-[hash][extname]",
      },
    },
  },
});
