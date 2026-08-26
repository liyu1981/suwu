import type { Terminal } from 'ghostty-web'

// SGR-1006 mouse report: CSI < button ; col ; row {M|m}
// Uppercase M = press/motion, lowercase m = release.
const sgr = (button: number, col: number, row: number, release: boolean) =>
  `\x1b[<${button};${col};${row}${release ? 'm' : 'M'}`

function modifiers(e: MouseEvent): number {
  let m = 0
  if (e.shiftKey) m += 4
  if (e.altKey) m += 8
  if (e.ctrlKey) m += 16
  return m
}

/**
 * Reports mouse events to the PTY as SGR-1006 escape sequences while the
 * application has mouse tracking enabled (DECSET 1000/1002/1003/1006).
 *
 * ghostty-web does not implement mouse reporting itself, so we attach capture
 * listeners on the terminal surface and feed encoded sequences back through
 * `term.input(data, true)` (which triggers onData -> WebSocket -> PTY).
 *
 * Returns a cleanup function.
 */
export function installMouseReporting(term: Terminal, container: HTMLElement): () => void {
  // Held buttons bitmask: 1 = left, 2 = middle, 4 = right.
  let held = 0

  const send = (s: string) => term.input(s, true)

  const cell = (e: MouseEvent) => {
    const rect = container.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const col = Math.max(
      1,
      Math.min(term.cols, Math.floor((x / Math.max(1, rect.width)) * term.cols) + 1),
    )
    const row = Math.max(
      1,
      Math.min(term.rows, Math.floor((y / Math.max(1, rect.height)) * term.rows) + 1),
    )
    return { col, row }
  }

  const active = () => term.hasMouseTracking()

  const onMouseDown = (e: MouseEvent) => {
    if (!active()) return
    e.preventDefault()
    e.stopPropagation()
    term.focus()
    held |= 1 << e.button
    const { col, row } = cell(e)
    const base = e.button === 1 ? 1 : e.button === 2 ? 2 : 0
    send(sgr(base + modifiers(e), col, row, false))
  }

  const onMouseUp = (e: MouseEvent) => {
    if (!active()) return
    e.preventDefault()
    e.stopPropagation()
    held &= ~(1 << e.button)
    const { col, row } = cell(e)
    const base = e.button === 1 ? 1 : e.button === 2 ? 2 : 0
    send(sgr(base + modifiers(e), col, row, true))
  }

  const onMouseMove = (e: MouseEvent) => {
    if (!active()) return
    e.preventDefault()
    e.stopPropagation()
    const { col, row } = cell(e)
    let base: number
    if (held & 1) base = 32 // left drag
    else if (held & 2) base = 33 // middle drag
    else if (held & 4) base = 34 // right drag
    else {
      // Button-free motion is only reported in any-event mode (DECSET 1003).
      if (!term.getMode(1003)) return
      base = 35
    }
    send(sgr(base + modifiers(e), col, row, false))
  }

  const onWheel = (e: WheelEvent) => {
    if (!active()) return
    e.preventDefault()
    e.stopPropagation()
    const { col, row } = cell(e)
    const button = e.deltaY < 0 ? 64 : 65 // wheel up / wheel down
    send(sgr(button + modifiers(e), col, row, false))
    send(sgr(button + modifiers(e), col, row, true))
  }

  const onContextMenu = (e: MouseEvent) => {
    if (active()) e.preventDefault()
  }

  container.addEventListener('mousedown', onMouseDown, true)
  window.addEventListener('mouseup', onMouseUp, true)
  window.addEventListener('mousemove', onMouseMove, true)
  container.addEventListener('wheel', onWheel, { capture: true, passive: false })
  container.addEventListener('contextmenu', onContextMenu)

  return () => {
    container.removeEventListener('mousedown', onMouseDown, true)
    window.removeEventListener('mouseup', onMouseUp, true)
    window.removeEventListener('mousemove', onMouseMove, true)
    container.removeEventListener('wheel', onWheel, { capture: true } as AddEventListenerOptions)
    container.removeEventListener('contextmenu', onContextMenu)
  }
}