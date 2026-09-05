import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CommonTileContainer, useReportTileState, useTileSessionState } from './CommonTileContainer'
import { RefreshIcon, SearchIcon } from './icons'
import { browserZoomAtom } from '../store/zoom'

// ── URL helpers ──────────────────────────────────────────────────

/** Returns true if the string looks like a URL (has a protocol or a TLD-like dot). */
function looksLikeUrl(input: string): boolean {
  const s = input.trim()
  if (/^https?:\/\//i.test(s)) return true
  // Match domain.tld patterns like "example.com", "sub.example.co.uk"
  if (/^[a-zA-Z0-9]([a-zA-Z0-9-]*\.)+[a-zA-Z]{2,}(\/.*)?$/.test(s)) return true
  // localhost with optional port
  if (/^localhost(:\d+)?(\/.*)?$/.test(s)) return true
  return false
}

/** Normalize user input into a full URL for the iframe src. */
function resolveUrl(input: string): string {
  const s = input.trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (/^localhost(:\d+)?/.test(s)) return `http://${s}`
  if (looksLikeUrl(s)) return `https://${s}`
  // Treat as search query
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

/** Extract display hostname from a URL string. */
function displayHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

// ── Styles ───────────────────────────────────────────────────────

const omniInput =
  'flex-1 min-w-0 bg-transparent text-[13px] text-white/90 placeholder-white/35 outline-none font-mono'

const omniBtn =
  'grid h-6 w-6 shrink-0 place-items-center rounded text-white/35 transition-all duration-150 hover:bg-white/[0.08] hover:text-white/70 active:scale-90 disabled:cursor-not-allowed disabled:opacity-20'

// ── History stack ────────────────────────────────────────────────

interface NavState {
  url: string
  title: string
}

// ── Main component ───────────────────────────────────────────────

interface Props {
  paneId: string
}

export default function BrowserPanel({ paneId }: Props) {
  const { t } = useTranslation()
  const savedState = useTileSessionState<{ url?: string; history?: NavState[]; index?: number }>()
  const reportState = useReportTileState(paneId)

  // Navigation state
  const [history, setHistory] = useState<NavState[]>(() => {
    if (savedState?.history?.length && savedState.url) {
      return savedState.history
    }
    return [{ url: 'https://www.google.com', title: 'Google' }]
  })
  const [historyIndex, setHistoryIndex] = useState(() => savedState?.index ?? 0)
  const [inputValue, setInputValue] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const currentUrl = history[historyIndex]?.url ?? ''

  // Report state for session persistence
  useEffect(() => {
    reportState({ url: currentUrl, history, index: historyIndex })
  }, [currentUrl, history, historyIndex, reportState])

  // Sync input with current URL when navigating
  useEffect(() => {
    setInputValue(currentUrl)
    setLoadError(null)
  }, [currentUrl])

  // ── Navigation ──────────────────────────────────────────────

  const navigateTo = useCallback((url: string) => {
    if (!url) return
    setIsLoading(true)
    setLoadError(null)
    setHistory((prev) => {
      const newHistory = prev.slice(0, historyIndex + 1)
      newHistory.push({ url, title: displayHost(url) })
      return newHistory
    })
    setHistoryIndex((prev) => prev + 1)
  }, [historyIndex])

  const goBack = useCallback(() => {
    if (historyIndex <= 0) return
    setHistoryIndex((prev) => prev - 1)
    setIsLoading(true)
    setLoadError(null)
  }, [historyIndex])

  const goForward = useCallback(() => {
    if (historyIndex >= history.length - 1) return
    setHistoryIndex((prev) => prev + 1)
    setIsLoading(true)
    setLoadError(null)
  }, [historyIndex, history.length])

  const refresh = useCallback(() => {
    setIsLoading(true)
    setLoadError(null)
    // Force reload by toggling src
    const iframe = iframeRef.current
    if (iframe) {
      iframe.src = currentUrl
    }
  }, [currentUrl])

  const handleOmniSubmit = useCallback(() => {
    const resolved = resolveUrl(inputValue)
    if (resolved) navigateTo(resolved)
  }, [inputValue, navigateTo])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleOmniSubmit()
      }
      // Escape: blur the input to return focus to the iframe
      if (e.key === 'Escape') {
        e.preventDefault()
        iframeRef.current?.focus()
      }
    },
    [handleOmniSubmit],
  )

  // ── Iframe load events ─────────────────────────────────────

  const handleLoad = useCallback(() => {
    setIsLoading(false)
    setLoadError(null)
  }, [])

  const handleError = useCallback(() => {
    setIsLoading(false)
    setLoadError(t('browser.loadError', { url: displayHost(currentUrl) }))
  }, [currentUrl, t])

  // ── Open in new tab fallback ───────────────────────────────

  const openInNewTab = useCallback(() => {
    window.open(currentUrl, '_blank', 'noopener,noreferrer')
  }, [currentUrl])

  // ── History button states ──────────────────────────────────

  const canGoBack = historyIndex > 0
  const canGoForward = historyIndex < history.length - 1

  return (
    <CommonTileContainer zoomAtom={browserZoomAtom} noPadding>
      <div className="flex h-full flex-col">
        {/* Omni bar */}
        <div className="flex shrink-0 items-center gap-1.5 rounded-t-[6px] border-b border-white/[0.06] px-2.5 py-1.5 glass-control">
          {/* Back */}
          <button
            type="button"
            disabled={!canGoBack}
            onClick={goBack}
            className={omniBtn}
            title={t('browser.back')}
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>

          {/* Forward */}
          <button
            type="button"
            disabled={!canGoForward}
            onClick={goForward}
            className={omniBtn}
            title={t('browser.forward')}
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>

          {/* Refresh */}
          <button
            type="button"
            disabled={!currentUrl}
            onClick={refresh}
            className={`grid h-6 w-6 shrink-0 place-items-center rounded transition-all duration-150 hover:bg-white/[0.08] active:scale-90 disabled:cursor-not-allowed disabled:opacity-20 ${
              isLoading ? 'text-amber-400/70 animate-spin' : 'text-white/35 hover:text-white/70'
            }`}
            title={t('browser.refresh')}
          >
            <RefreshIcon className="h-3 w-3" />
          </button>

          {/* URL / search input */}
          <div className="flex flex-1 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2 py-1 transition-all duration-150 focus-within:bg-white/[0.12] focus-within:ring-1 focus-within:ring-sky-400/30">
            <SearchIcon className="h-3 w-3 shrink-0 text-white/25" />
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={(e) => e.target.select()}
              placeholder={t('browser.omniPlaceholder')}
              className={omniInput}
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          {/* Open in new tab */}
          <button
            type="button"
            disabled={!currentUrl}
            onClick={openInNewTab}
            className={omniBtn}
            title={t('browser.openNewTab')}
          >
            <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        </div>

        {/* Loading bar */}
        {isLoading && (
          <div className="relative h-0.5 w-full shrink-0 overflow-hidden bg-white/[0.04]">
            <div className="absolute inset-y-0 left-0 w-1/3 animate-browser-loading rounded-full bg-sky-400/60" />
          </div>
        )}

        {/* Content area */}
        <div className="relative min-h-0 flex-1">
          {/* Error overlay */}
          {loadError && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60 backdrop-blur-sm">
              <svg className="h-8 w-8 text-white/25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
              <p className="max-w-xs text-center text-[12px] text-white/50">{loadError}</p>
              <button
                type="button"
                onClick={openInNewTab}
                className="rounded-lg bg-white/10 px-3 py-1.5 text-[11px] font-medium text-white/70 transition hover:bg-white/15 hover:text-white/90"
              >
                {t('browser.openExternal')}
              </button>
            </div>
          )}

          {/* Inner sandboxed iframe */}
          {currentUrl && (
            <iframe
              ref={iframeRef}
              key={currentUrl}
              src={currentUrl}
              sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
              className="h-full w-full border-0 bg-white"
              onLoad={handleLoad}
              onError={handleError}
              title={`browser-${paneId}`}
            />
          )}
        </div>
      </div>
    </CommonTileContainer>
  )
}
