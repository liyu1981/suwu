import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileViewerRenderers } from '@file-viewer/vite-plugin'
import { wgslVitePlugin } from '@vgpu/wgsl/loader-vite'
import { fileURLToPath } from 'node:url'
import { readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import pkg from '../package.json'

// Injected so the About dialog can show the root package's version.
const appVersion = (pkg as { version?: string }).version ?? '0.0.0'

// Port of the Go demo server that `pnpm dev:web` proxies /api and /ws to.
// Set DEMO_PORT (or HTTP_PORT) to match the running Go server; the dev
// wrapper defaults to HTTP on port 8000.
const demoPort = process.env.DEMO_PORT || process.env.HTTP_PORT || '8000'
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

// Mirror the Go server's root-path guard in the dev server: a sandboxed
// /staticserve/ page that asks for /static/app.js must get 404, not Vite's
// SPA fallback. Extension/background routes legitimately use opaque origins.
function staticPreviewGuard(): import('vite').Plugin {
  return {
    name: 'suwu-static-preview-guard',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''
        if (
          url.startsWith('/staticserve') ||
          url.startsWith('/gqjs') ||
          url.startsWith('/backgrounds')
        ) {
          next()
          return
        }
        const origin = req.headers.origin
        const referer = req.headers.referer
        let isPreview = origin === 'null'
        if (referer) {
          try {
            if (new URL(referer).pathname.startsWith('/staticserve/')) isPreview = true
          } catch {
            // Ignore malformed Referer values.
          }
        }
        if (isPreview) {
          res.statusCode = 404
          res.end('Not found')
          return
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    fileViewerRenderers({ copyAssets: true, renderers: ['word', 'pdf', 'ofd', 'presentation-openxml', 'spreadsheet', 'archive', 'email', 'text', 'image', 'media'] }),
    wgslVitePlugin(),
    fixGoEmbedFiles(),
    staticPreviewGuard(),
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
      '/backgrounds': { target: demoTarget, changeOrigin: false },
      '/gqjs': { target: demoTarget, changeOrigin: false },
      '/staticserve': { target: demoTarget, changeOrigin: false },
      '/ws': { target: demoTarget.replace(/^http/, 'ws'), ws: true, changeOrigin: false },
    },
  },
})