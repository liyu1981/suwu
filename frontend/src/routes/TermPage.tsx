import { useEffect } from 'react'
import FullTerminal from '../components/FullTerminal'

/**
 * Full-space terminal page loaded inside each tiling pane's iframe.
 * Rendered outside the app shell so it has no header and fills the iframe.
 */
export default function TermPage() {
  // The pane paints its own user-configurable (possibly translucent)
  // background; the global stylesheet gives `html` an opaque page color,
  // which would sit behind it and defeat the alpha channel.
  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent'
  }, [])
  return <FullTerminal />
}
