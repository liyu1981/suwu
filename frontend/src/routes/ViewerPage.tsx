import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Full-space viewer page loaded inside each viewer pane's iframe.
 * Displays the file path passed via ?path= URL param.
 */
export default function ViewerPage() {
  const { t } = useTranslation()
  const filePathRef = useRef<string | null>(null)

  // Read path from URL params (only once on mount).
  if (filePathRef.current === null) {
    filePathRef.current = new URLSearchParams(window.location.search).get('path')
  }

  useEffect(() => {
    document.documentElement.style.backgroundColor = 'transparent'
  }, [])

  const filePath = filePathRef.current

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-transparent">
      {filePath ? (
        <>
          <svg className="h-10 w-10 text-white/20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          <span className="max-w-xs truncate text-sm text-white/40">{filePath}</span>
          <span className="text-xs text-white/20">{t('filebrowser.viewerEmpty')}</span>
        </>
      ) : (
        <span className="text-sm text-white/20">{t('filebrowser.viewerEmpty')}</span>
      )}
    </div>
  )
}
