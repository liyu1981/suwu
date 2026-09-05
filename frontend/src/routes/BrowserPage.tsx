import { useEffect, useMemo } from 'react'
import BrowserPanel from '../components/BrowserPanel'
import { setPageTransparent } from '../lib/constants'

/**
 * Full-space browser page loaded inside each tiling pane's iframe.
 * Rendered outside the app shell so it has no header and fills the iframe.
 */
export default function BrowserPage() {
  useEffect(() => {
    setPageTransparent()
  }, [])

  const paneId = useMemo(() => new URLSearchParams(window.location.search).get('pane') ?? '', [])

  return <BrowserPanel paneId={paneId} />
}
