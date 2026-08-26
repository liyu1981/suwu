import { useEffect, useRef, useState } from 'react'
import { Terminal, FitAddon, type ITerminalOptions } from 'ghostty-web'
import { getGhostty } from '../lib/ghostty'

/**
 * Creates a ghostty-web Terminal inside a container ref once the WASM module
 * has loaded. Returns the container ref (for rendering) and the Terminal.
 */
export function useTerminal(options: ITerminalOptions) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [term, setTerm] = useState<Terminal | null>(null)

  useEffect(() => {
    let cancelled = false
    let t: Terminal | null = null

    void (async () => {
      const ghostty = await getGhostty()
      if (cancelled || !containerRef.current) return
      t = new Terminal({ ...options, ghostty })
      const fit = new FitAddon()
      t.loadAddon(fit)
      t.open(containerRef.current)
      fit.fit()
      fit.observeResize()
      setTerm(t)
    })()

    return () => {
      cancelled = true
      t?.dispose()
    }
    // Options are static per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { containerRef, term }
}