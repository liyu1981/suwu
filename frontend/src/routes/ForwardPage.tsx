import { useEffect } from 'react'
import ForwardPanel from '../components/ForwardPanel'

/**
 * Full-space port forward page loaded inside each tiling pane's iframe.
 * Rendered outside the app shell so it has no header and fills the iframe.
 */
export default function ForwardPage() {
  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent'
  }, [])
  return <ForwardPanel />
}
