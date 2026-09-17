import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { CloseIcon } from '../icons'
import type { SearchLocation } from './search'
import type { useOccurrenceSearch } from './useOccurrenceSearch'

interface Props {
  search: ReturnType<typeof useOccurrenceSearch>
  onNavigate: (path: string, location: SearchLocation) => Promise<void>
  onRestoreFocus: () => void
}

export function SearchOccurrencesDialog({ search, onNavigate, onRestoreFocus }: Props) {
  const { t } = useTranslation()
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const navigationVersion = useRef(0)
  const { open, result, loading } = search

  useEffect(() => {
    navigationVersion.current++
    setOpening(false)
    setNavigationError(null)
    return () => { navigationVersion.current++ }
  }, [open, result])

  const navigate = async (path: string, location: SearchLocation) => {
    const version = ++navigationVersion.current
    setOpening(true)
    setNavigationError(null)
    try {
      await onNavigate(path, location)
      if (version === navigationVersion.current) search.close()
    } catch (e) {
      if (version === navigationVersion.current) {
        setNavigationError(e instanceof Error ? e.message : t('codeExplorer.loadFailed'))
      }
    } finally {
      if (version === navigationVersion.current) setOpening(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) search.close() }}>
      <DialogContent
        className="flex w-[min(92vw,52rem)] flex-col gap-3 p-4"
        aria-describedby="occurrence-search-description"
        onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus() }}
      >
        <div className="flex items-center justify-between gap-3">
          <DialogTitle>{t('codeExplorer.search.title')}</DialogTitle>
          <button
            type="button"
            className="glass-btn grid h-7 w-7 shrink-0 place-items-center rounded text-white/60 hover:text-white"
            aria-label={t('codeExplorer.search.close')}
            title={t('codeExplorer.search.close')}
            onClick={search.close}
          >
            <span aria-hidden="true"><CloseIcon /></span>
          </button>
        </div>
        <p id="occurrence-search-description" className="text-[11px] text-white/60">
          {t('codeExplorer.search.diskHint')}
        </p>
        <pre className="scrollbar-thin max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-black/20 p-2 font-mono text-sm">{search.query}</pre>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); search.run() }}>
          <label className="min-w-0 flex-1 text-xs">
            {t('codeExplorer.search.directory')}
            <input
              value={search.directory}
              onChange={(event) => search.setDirectory(event.target.value)}
              spellCheck={false}
              className="mt-1 w-full rounded border border-white/15 bg-black/20 px-2 py-1.5 text-sm outline-none focus:border-white/40"
            />
          </label>
          <label className="shrink-0 text-xs">
            {t('codeExplorer.search.extension')}
            <input
              value={search.extension}
              onChange={(event) => search.setExtension(event.target.value)}
              spellCheck={false}
              placeholder={t('codeExplorer.search.allExtensions')}
              title={t('codeExplorer.search.extensionHint')}
              className="mt-1 block w-28 rounded border border-white/15 bg-black/20 px-2 py-1.5 text-sm outline-none focus:border-white/40"
            />
          </label>
          <button type="submit" disabled={!search.directory || opening} className="glass-btn rounded px-3 py-2 text-xs disabled:opacity-40">
            {t(result ? 'codeExplorer.search.again' : 'codeExplorer.search.submit')}
          </button>
        </form>
        <div role="status" aria-live="polite" className="text-xs text-white/70">
          {loading ? t('codeExplorer.search.loading') : result ? t('codeExplorer.search.count', { count: result.returnedMatches, files: result.files.length }) : t('codeExplorer.search.ready')}
          {opening && ` · ${t('codeExplorer.search.opening')}`}
        </div>
        {(search.error || navigationError) && <p role="alert" className="text-[11px] text-red-300">{navigationError ?? search.error}</p>}
        {result && (
          <>
            <div className="break-all text-[11px] text-white/60">{result.directory}</div>
            {(result.truncated || result.warnings.length > 0) && (
              <div role="status" className="rounded bg-amber-500/10 p-2 text-[11px] text-amber-200">
                {result.truncated && <p>{t('codeExplorer.search.partial')}</p>}
                {result.warnings.map((warning) => <p key={warning}>{t(`codeExplorer.search.warnings.${warning}`)}</p>)}
              </div>
            )}
            <div
              ref={listRef}
              className="scrollbar-thin min-h-0 flex-1 overflow-auto rounded border border-white/10 bg-black/20"
              onKeyDown={(event) => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
                if (!buttons.length) return
                event.preventDefault()
                const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
                const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
                buttons[index]?.focus()
              }}
            >
              {result.files.length === 0 && <p className="p-4 text-sm text-white/60">{t('codeExplorer.search.empty')}</p>}
              {result.files.map((file) => (
                <section key={file.path}>
                  <h3 className="break-all bg-white/5 px-3 py-2 text-sm font-medium" title={file.path}>{file.relativePath}</h3>
                  {file.matches.map((match, index) => (
                    <button
                      key={`${match.line}:${match.column}:${index}`}
                      type="button"
                      disabled={opening}
                      onClick={() => void navigate(file.path, match)}
                      className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline focus-visible:outline-white/40 disabled:opacity-50"
                    >
                      <span className="shrink-0 pt-0.5 font-mono text-xs text-white/50">{match.line}:{match.column}</span>
                      <code className="min-w-0 whitespace-pre-wrap break-all font-mono text-sm text-white/80">
                        {match.preview.slice(0, match.previewStart)}
                        <mark className="rounded bg-amber-400/25 text-amber-100">{match.preview.slice(match.previewStart, match.previewEnd)}</mark>
                        {match.preview.slice(match.previewEnd)}
                      </code>
                    </button>
                  ))}
                </section>
              ))}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
