import { useEffect } from 'react'
import ForwardPanel from '../components/ForwardPanel'
import { setPageTransparent } from '../lib/constants'

/**
 * Full-space port forward page loaded inside each tiling pane's iframe.
 * Rendered outside the app shell so it has no header and fills the iframe.
 */
export default function ForwardPage() {
  useEffect(() => {
    setPageTransparent()
  }, [])
  return <ForwardPanel />
}
