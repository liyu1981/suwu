import { useEffect, type RefObject } from 'react'
import type { Terminal } from 'ghostty-web'
import { installMouseReporting } from '../lib/mouse'

/**
 * Enables SGR-1006 mouse reporting to the PTY once the terminal is ready.
 * See pkg/lib/mouse for details on the encoding and mode gating.
 */
export function useMouseReporting(
  term: Terminal | null,
  containerRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    if (!term || !containerRef.current) return
    return installMouseReporting(term, containerRef.current)
  }, [term, containerRef])
}