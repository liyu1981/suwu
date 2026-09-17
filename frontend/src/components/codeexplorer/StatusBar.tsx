import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface StatusBarProps {
  path: string | null
  language: string | null
  line: number
  column: number
  saving: boolean
  anyDirty: boolean
  savedAt: number
  canReload: boolean
  onSave: () => void
  onReload: () => void
}

const btn =
  'grid h-5 w-5 shrink-0 place-items-center rounded text-white/45 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent'

/** Bottom status bar: copyable path, file type, cursor position and save state. */
export function StatusBar({
  path,
  language,
  line,
  column,
  saving,
  anyDirty,
  savedAt,
  canReload,
  onSave,
  onReload,
}: StatusBarProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [showSaved, setShowSaved] = useState(false)

  useEffect(() => {
    if (savedAt === 0) return
    setShowSaved(true)
    const timer = window.setTimeout(() => setShowSaved(false), 2000)
    return () => window.clearTimeout(timer)
  }, [savedAt])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const status = saving
    ? t('codeExplorer.saving')
    : anyDirty
      ? t('codeExplorer.unsaved')
      : showSaved
        ? t('codeExplorer.saved')
        : t('codeExplorer.allSaved')

  const copyPath = () => {
    if (!path) return
    void (async () => {
      try {
        await navigator.clipboard?.writeText(path)
        setCopied(true)
      } catch {
        // Clipboard unavailable (e.g. insecure context) — ignore.
      }
    })()
  }

  return (
    <div className="flex h-6 shrink-0 items-center gap-2 border-t border-white/5 bg-black/20 px-2 text-[10px] text-white/45">
      {path ? (
        <button
          type="button"
          onClick={copyPath}
          title={copied ? t('codeExplorer.copied') : `${t('codeExplorer.copyPath')}: ${path}`}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-0.5 text-left transition hover:bg-white/5 hover:text-white/70"
        >
          {copied ? (
            <svg className="h-3 w-3 shrink-0 text-emerald-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
              <rect x="5" y="5" width="8" height="8" rx="1.5" />
              <path d="M3 10V3.5A1.5 1.5 0 0 1 4.5 2H10" />
            </svg>
          )}
          <span className="min-w-0 truncate">{path}</span>
        </button>
      ) : (
        <span className="min-w-0 flex-1" />
      )}

      {language && <span className="shrink-0">{language}</span>}
      {path && <span className="shrink-0">{t('codeExplorer.cursor', { line, column })}</span>}
      <span className="shrink-0">{status}</span>
      {canReload && (
        <button type="button" onClick={onReload} aria-label={t('codeExplorer.reload')} title={t('codeExplorer.reload')} className={btn}>
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
          </svg>
        </button>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={!anyDirty || saving}
        aria-label={t('codeExplorer.save')}
        title={`${t('codeExplorer.save')} (Ctrl/Cmd+S)`}
        className={btn}
      >
        <svg className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <path d="M3 2h8l2 2v10H3z" />
          <path d="M5.5 2v4h5V2" />
          <path d="M5 9h6v5H5z" />
        </svg>
      </button>
    </div>
  )
}
