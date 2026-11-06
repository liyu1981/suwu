/**
 * Vite build for the Excalidraw extension tile.
 *
 * Output is a self-contained `dist/` served by suwu.static through
 * /gqjs/static/excalidraw/. Three things a plain Vite build would not do on its
 * own, all handled below:
 *
 *   1. Excalidraw builds its font URLs at runtime from `"./fonts/…"` string
 *      literals, so Vite cannot see them and would not emit those files. A tiny
 *      copy step mirrors upstream's `dist/prod/fonts/` into `dist/fonts/`,
 *      which is where EXCALIDRAW_ASSET_PATH points (see src/main.js).
 *   2. `manifest: true` writes `dist/.vite/manifest.json`; the render stub
 *      (index.js) reads it so hashed filenames can be injected into the page.
 *   3. `base: "./"` keeps every asset URL relative, so the same dist/ works at
 *      whatever path the static handler serves it from.
 *   4. Dynamic imports stay dynamic. Excalidraw lazy-loads its i18n tables (70
 *      chunks, 1.36 MB) and the mermaid/diagram machinery (33 chunks, 1.75 MB),
 *      so code splitting keeps the first paint to the entry graph (~1.3 MB) and
 *      fetches those only when a locale or diagram needs them. The file count
 *      that used to argue for one bundle no longer matters: `suwu.static` is a
 *      single `dist.zip`, so ~160 chunks are one blob in git, in the install
 *      payload and in the catalog.
 */
import { defineConfig } from "vite";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Absolute path to the installed @excalidraw/excalidraw production build.
 *
 * Only the bare specifier is resolvable from CJS (`./package.json` and
 * `./index.css` are behind conditions that exclude `require`), and it resolves
 * to dist/prod/index.js — whose directory is what we want.
 */
function excalidrawDist(): string {
  return dirname(require.resolve("@excalidraw/excalidraw"));
}

/**
 * Copy upstream's runtime assets (fonts) next to the bundle. They are not in the
 * import graph, so nothing else would bring them along.
 */
function excalidrawAssets() {
  return {
    name: "suwu:excalidraw-assets",
    apply: "build" as const,
    closeBundle() {
      const src = join(excalidrawDist(), "fonts");
      if (!existsSync(src)) {
        this.warn(`no fonts directory at ${src}; handwritten fonts will fall back`);
        return;
      }
      const out = join(__dirname, "dist", "fonts");
      mkdirSync(out, { recursive: true });
      cpSync(src, out, { recursive: true });
    },
  };
}

export default defineConfig({
  root: __dirname,
  // Nothing in public/ — the shell HTML is produced server-side by index.js.
  publicDir: false,
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    manifest: true,
    sourcemap: false,
    // Excalidraw's vendor graph is large by nature; the warning would fire on
    // every build without telling us anything actionable.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: join(__dirname, "src", "main.js"),
      output: {
        entryFileNames: "assets/app-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  plugins: [excalidrawAssets()],
});
