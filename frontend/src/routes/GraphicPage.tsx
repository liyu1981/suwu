import { useEffect, useMemo } from 'react'
import GUIAppPane from '../components/GraphicAppPane'
import { CommonTileContainer } from '../components/CommonTileContainer'
import { xdisplayZoomAtom } from '../store/zoom'
import { setPageTransparent } from '../lib/constants'

/**
 * Full-space GUI app page loaded inside each tiling pane's iframe.
 * Streams a remote X11 display onto a canvas with input injection.
 */
export default function GUIAppPage() {
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
    <CommonTileContainer zoomAtom={xdisplayZoomAtom} noPadding>
      <GUIAppPane key={`${paneId}-${display ?? ''}-${title ?? ''}-${desktop ?? ''}-${fps ?? ''}`} display={display} title={title} desktop={desktop} fps={fps} />
    </CommonTileContainer>
  )
}
