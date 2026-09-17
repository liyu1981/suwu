import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Dialog } from 'radix-ui'
import { useTranslation } from 'react-i18next'
import type { GitCommit } from './graph'
import { comparisonRequest, type Comparison } from './comparison'

export function CompareCommitDialog({ commit, commits, repoPath, mode, onCancel, onOpen }: {
  commit: GitCommit; commits: GitCommit[]; repoPath: string; mode: 'parent' | 'custom'
  onCancel: () => void; onOpen: (comparison: Comparison) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<GitCommit | null>(null)
  const [index, setIndex] = useState(0)
  const [parent, setParent] = useState('1')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  const matches = useMemo(() => {
    const search = query.trim().toLowerCase()
    return commits.filter(c => c.hash !== 'UNCOMMITTED' && (c.hash.toLowerCase().startsWith(search) || c.message.toLowerCase().includes(search))).slice(0, 8)
  }, [commits, query])
  const submit = async () => {
    if (busy || (mode === 'custom' && !selected)) return
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setBusy(true); setError('')
    try {
      // Custom comparison: right-clicked commit is the left snapshot, picker is right.
      const params: Record<string, string> = mode === 'parent'
        ? { path: repoPath, target: commit.hash, parent }
        : { path: repoPath, base: commit.hash, target: selected!.hash }
      const comparison = await comparisonRequest<Comparison>('compare', params, controller.signal)
      if (!controller.signal.aborted) onOpen(comparison)
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : t('gitCompare.failed'))
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  // Ordinary parent comparisons open immediately; merges expose a parent choice.
  useEffect(() => { if (mode === 'parent' && commit.parents.length < 2) void submit() }, [])
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onCancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[9998] bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[9999] max-h-[90vh] w-[min(90vw,480px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-white/10 p-4 text-white/80 shadow-2xl menu-glass">
          <Dialog.Title className="text-base font-semibold tracking-tight text-white/90">{t('gitCompare.compare')}</Dialog.Title>
          <Dialog.Description className="mt-1 text-[11px] text-white/55">{t('gitCompare.direction')}</Dialog.Description>
          {mode === 'custom' ? <>
            <div className="my-3 text-xs text-white/60">{t('gitCompare.left')}: <span className="font-mono">{commit.hash.slice(0, 7)}</span> — {commit.message}</div>
            <label htmlFor={id} className="mb-1 block text-xs">{t('gitCompare.right')}</label>
            <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={!selected} aria-controls={`${id}-results`} aria-activedescendant={!selected && matches[index] ? `${id}-${index}` : undefined}
              className="w-full rounded-lg border border-white/15 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-sky-400" placeholder={t('gitCompare.searchCommits')} value={query}
              onChange={e => { setQuery(e.target.value); setSelected(null); setIndex(0) }}
              onKeyDown={e => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSelected(null); setIndex(i => Math.max(0, Math.min(matches.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))) }
                if (e.key === 'Enter') { e.preventDefault(); if (selected) void submit(); else if (matches[index]) { setSelected(matches[index]); setQuery(`${matches[index].hash.slice(0, 7)} — ${matches[index].message}`) } }
              }} />
            {!selected && <div id={`${id}-results`} role="listbox" aria-label={t('gitCompare.searchCommits')} className="scrollbar-thin mt-1 max-h-[50vh] overflow-y-auto rounded-lg border border-white/10 bg-black/20">
              {matches.map((c, i) => <div key={c.hash} id={`${id}-${i}`} role="option" aria-selected={index === i} onMouseDown={e => e.preventDefault()}
                onClick={() => { setSelected(c); setQuery(`${c.hash.slice(0, 7)} — ${c.message}`) }}
                className={`cursor-pointer px-3 py-2 ${index === i ? 'bg-sky-500/20' : 'hover:bg-white/5'}`}>
                <div className="truncate text-sm">{c.message}</div><div className="text-[10px] text-white/50"><span className="font-mono">{c.hash.slice(0, 7)}</span> · {c.author} · {new Date(c.date).toLocaleDateString()}</div>
              </div>)}
              {!matches.length && <p className="p-3 text-[11px] text-white/50">{t('gitCompare.noMatches')}</p>}
            </div>}
            <p className="mt-2 text-[11px] text-white/40">{t('gitCompare.loadedSearch')}</p>
          </> : <div className="my-3 space-y-2">
            <p className="text-xs">{t('gitCompare.right')}: <span className="font-mono">{commit.hash.slice(0, 7)}</span> — {commit.message}</p>
            {commit.parents.length > 1 && <label className="block text-xs">{t('gitCompare.parent')}<select value={parent} onChange={e => setParent(e.target.value)} className="mt-1 w-full rounded border border-white/15 bg-slate-900 p-2 text-sm">
              {commit.parents.map((hash, i) => <option key={hash} value={i + 1}>{i + 1}: {hash.slice(0, 12)}</option>)}
            </select></label>}
          </div>}
          {error && <p role="alert" className="mt-3 text-[11px] text-red-300">{error}</p>}
          <div className="mt-4 flex gap-2">
            <button type="button" className="rounded-lg bg-sky-500/20 px-3 py-2 text-xs text-sky-200 disabled:opacity-40" disabled={busy || (mode === 'custom' && !selected)} onClick={() => void submit()}>{t(busy ? 'gitCompare.loading' : 'gitCompare.view')}</button>
            <Dialog.Close className="rounded-lg bg-white/5 px-3 py-2 text-xs">{t('gitCompare.cancel')}</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
