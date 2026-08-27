import { useEffect } from 'react'
import type { Terminal } from '@xterm/xterm'

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard writes need a secure context; ignore failures (e.g. plain HTTP).
  }
}

/**
 * Selection & clipboard behavior for the terminal:
 * - Selecting text auto-copies to the clipboard when the selection settles.
 * - Ctrl+Shift+C / Cmd+C always copies; Ctrl+C copies only when a selection
 *   exists, otherwise ^C reaches the shell. Pasting stays xterm-native.
 */
export function useTermCopy(term: Terminal | null) {
  useEffect(() => {
    if (!term) return

    let last = ''
    let timer: number | undefined
    const onSelectionChange = term.onSelectionChange(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const sel = term.getSelection()
        if (sel && sel !== last) {
          last = sel
          void copyText(sel)
        }
      }, 250)
    })

    term.attachCustomKeyEventHandler((e) => {
      const meta = e.ctrlKey || e.metaKey
      if (!meta || e.altKey || e.key.toLowerCase() !== 'c') return true
      const sel = term.getSelection()
      if (!sel) return true
      e.preventDefault()
      void copyText(sel)
      return false
    })

    return () => {
      onSelectionChange.dispose()
      window.clearTimeout(timer)
    }
  }, [term])
}
