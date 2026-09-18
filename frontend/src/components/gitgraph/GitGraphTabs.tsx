import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { WORKTREE_REF, type DiffTab } from './comparison'

export function GitGraphTabs({ tabs, active, onSelect, onClose }: {
  tabs: DiffTab[]; active: string; onSelect: (id: string) => void; onClose: (id: string) => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [active])
  if (!tabs.length) return null
  const label = (ref: string) => ref === 'EMPTY' ? t('gitCompare.emptyTree') : ref === WORKTREE_REF ? t('gitCompare.worktree') : ref.slice(0, 7)
  const all = [{ id: 'commits', label: t('gitCompare.commits') }, ...tabs.map(tab => ({ id: tab.id, label: `${label(tab.base)} → ${label(tab.target)}` }))]
  return (
    <div ref={ref} role="tablist" aria-label={t('gitCompare.tabs')} className="flex shrink-0 overflow-x-auto border-b border-white/10 glass-control scrollbar-thin"
      onKeyDown={e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
        e.preventDefault()
        const index = all.findIndex(tab => tab.id === active)
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length
        onSelect(all[next].id)
        ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}>
      {all.map((tab, index) => (
        <div key={tab.id} className={`flex shrink-0 items-center border-r border-white/10 ${active === tab.id ? 'bg-white/10 text-white' : 'text-white/55'}`}>
          <button type="button" role="tab" id={`git-tab-${index}`} aria-controls={`git-panel-${index}`} aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1}
            className="px-3 py-2 text-xs outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400" title={tab.label} onClick={() => onSelect(tab.id)}>{tab.label}</button>
          {index > 0 && <button type="button" aria-label={t('gitCompare.closeTab', { label: tab.label })} title={t('gitCompare.closeTab', { label: tab.label })}
            className="mr-1 rounded px-1.5 text-xs hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-sky-400" onClick={() => onClose(tab.id)}>×</button>}
        </div>
      ))}
    </div>
  )
}
