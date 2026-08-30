import { useEffect } from 'react'
import { wmAction } from '../wm/shortcuts'

interface Props {
  paneId?: string
  children: React.ReactNode
}

/**
 * Common container for all tile iframe pages. Handles:
 * - Notifying the parent window manager when this pane gains focus
 * - Relaying WM keyboard shortcuts (Alt+arrows, etc.) to the parent
 *
 * Usage:
 *   <CommonTileContainer paneId={paneId}>
 *     <MyTileContent />
 *   </CommonTileContainer>
 */
export function CommonTileContainer({ paneId, children }: Props) {
  // Notify parent when this iframe gains focus.
  useEffect(() => {
    const onFocus = () => {
      const id = paneId ?? window.frameElement?.getAttribute('data-pane')
      if (id) {
        window.parent?.postMessage({ type: 'pane-focus', pane: id }, '*')
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [paneId])

  // Relay WM keyboard shortcuts to parent.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = wmAction(e)
      if (!a) return
      e.preventDefault()
      e.stopPropagation()
      window.parent?.postMessage({ type: 'wm-shortcut', action: a }, '*')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return <>{children}</>
}
