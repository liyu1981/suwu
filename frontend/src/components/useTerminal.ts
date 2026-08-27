import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITerminalOptions } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'

/**
 * Creates an xterm.js Terminal inside a container ref. Loads the FitAddon,
 * prefers the accelerated WebGL renderer (transparently falling back to the
 * built-in renderer when no GL context is available), and keeps the grid
 * fitted to the container size via a ResizeObserver.
 */
export function useTerminal(
  options: ITerminalOptions,
  initialSize?: { cols: number; rows: number },
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [term, setTerm] = useState<Terminal | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const t = new Terminal(options)
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(containerRef.current)
    // xterm 6 has no cols/rows options; set them explicitly before fitting so
    // the grid is sane even if the container has no measurable box yet.
    if (initialSize) t.resize(initialSize.cols, initialSize.rows)

    let webgl: WebglAddon | null = null
    try {
      webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl?.dispose()
        webgl = null
      })
      t.loadAddon(webgl)
    } catch {
      webgl?.dispose()
      webgl = null
    }

    // The fit addon has no built-in observer: refit on container box changes.
    const ro = new ResizeObserver(() => fit.fit())
    ro.observe(containerRef.current)
    fit.fit()
    setTerm(t)
    // Debug handle for console tinkering and headless verification.
    ;(window as unknown as Record<string, unknown>).__term = t

    return () => {
      ro.disconnect()
      webgl?.dispose()
      t.dispose()
    }
    // Options are static per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { containerRef, term }
}

