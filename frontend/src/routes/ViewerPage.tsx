import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Full-space viewer page loaded inside each viewer pane's iframe.
 * Placeholder — renders an empty dark surface.
 */
export default function ViewerPage() {
  const { t } = useTranslation()
  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent'
  }, [])
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent">
      <span className="text-sm text-white/20">{t('filebrowser.viewerEmpty')}</span>
    </div>
  )
}
