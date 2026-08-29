import { useEffect } from 'react'

/**
 * Full-space viewer page loaded inside each viewer pane's iframe.
 * Placeholder — renders an empty dark surface.
 */
export default function ViewerPage() {
  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent'
  }, [])
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent">
      <span className="text-sm text-white/20">Viewer — empty</span>
    </div>
  )
}
