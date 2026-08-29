import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileViewerRenderers } from '@file-viewer/vite-plugin'
import { fileURLToPath } from 'node:url'
import { readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import pkg from '../package.json'

// Injected so the About dialog can show the root package's version.
const appVersion = (pkg as { version?: string }).version ?? '0.0.0'

// Port of the Go demo server that `pnpm dev:web` proxies /api and /ws to.
// Set DEMO_PORT (or PORT) to match the running Go server; the Go dev default
// is 8000.
const demoPort = process.env.DEMO_PORT || process.env.PORT || '8000'
const demoTarget = `http://127.0.0.1:${demoPort}`

// Build output is written directly into pkg/assets/web, the directory embedded
// into the Go binary, so `npm run build` produces what `go build` serves.

// Vite plugin to rename files with trailing dots (invalid for Go embed).
function fixGoEmbedFiles(): import('vite').Plugin {
  return {
    name: 'fix-go-embed-files',
    enforce: 'post',
    closeBundle: async () => {
      const assetsDir = fileURLToPath(new URL('../pkg/assets/web/assets', import.meta.url))
      const entries = await readdir(assetsDir)
      for (const entry of entries) {
        if (entry.endsWith('.')) {
          const oldPath = join(assetsDir, entry)
          const newName = entry.slice(0, -1)
          const newPath = join(assetsDir, newName)
          await rename(oldPath, newPath)
        }
      }
    },
  }
}
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    fileViewerRenderers({ copyAssets: true, renderers: ['word', 'pdf', 'ofd', 'presentation-openxml', 'spreadsheet', 'archive', 'email', 'text', 'image', 'media'] }),
    fixGoEmbedFiles(),
  ],
  define: {
    __SUWU_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../pkg/assets/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: true,
    proxy: {
      // Forward API + WebSocket traffic to the Go demo server.
      '/api': { target: demoTarget, changeOrigin: false },
      '/ws': { target: demoTarget.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
})