import { useEffect, useMemo } from 'react'
import GraphicAppPane from '../components/GraphicAppPane'
import { CommonTileContainer } from '../components/CommonTileContainer'
import { graphicZoomAtom } from '../store/zoom'
import { setPageTransparent } from '../lib/constants'

/**
 * Full-space graphic app page loaded inside each tiling pane's iframe.
 * Streams a remote X11 display (Xvfb) onto a canvas with input injection.
 */
export default function GraphicPage() {
  useEffect(() => {
    setPageTransparent()
  }, [])

  const { paneId, display, title, desktop, fps } = useMemo(() => {
    const q = new URLSearchParams(window.location.search)
    return {
      paneId: q.get('pane') ?? '',
      display: q.get('display') ?? undefined,
      title: q.get('title') ?? undefined,
      desktop: q.get('desktop') ?? undefined,
      fps: q.get('fps') ? parseInt(q.get('fps')!, 10) : undefined,
    }
  }, [])

  return (
    <CommonTileContainer zoomAtom={graphicZoomAtom} noPadding>
      <GraphicAppPane key={`${paneId}-${display ?? ''}-${title ?? ''}-${desktop ?? ''}-${fps ?? ''}`} display={display} title={title} desktop={desktop} fps={fps} />
    </CommonTileContainer>
  )
}
