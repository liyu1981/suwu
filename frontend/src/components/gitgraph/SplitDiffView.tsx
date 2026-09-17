import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { diffFontFamilyAtom } from '../../store/appearance'
import type { PatchHunk, PatchLine } from './comparison'
import { alignDiffLines, highlightWords, type SplitRow, type WordSpan } from './splitDiff'

type Row = { kind: 'hunk'; header: string } | { kind: 'note'; text: string } | SplitRow

function GutterCell({ line, side, spans }: { line: PatchLine | null; side: 'old' | 'new'; spans?: WordSpan[] }) {
  const changed = line !== null && line.kind !== 'context'
  return (
    <div className={`flex min-w-0 items-start ${line === null ? 'bg-white/[0.02]' : changed ? side === 'old' ? 'bg-red-500/10' : 'bg-green-500/10' : ''}`}>
      <span aria-hidden="true" className="sticky left-0 z-10 flex w-16 shrink-0 select-none items-center self-stretch bg-black/75 px-2 text-[11px] text-white/40">
        <span className="w-8 text-right">{line?.[side] ?? ''}</span>
        <span className="w-5 text-center text-white/60">{changed ? side === 'old' ? '−' : '+' : ''}</span>
      </span>
      <code className={`block min-w-0 whitespace-pre pr-4 ${changed ? side === 'old' ? 'text-red-200' : 'text-green-200' : 'text-white/75'}`}>
        {spans ? spans.map((span, i) => <span key={i} className={span.highlight ? side === 'old' ? 'rounded-sm bg-red-400/25' : 'rounded-sm bg-green-400/25' : undefined}>{span.text}</span>) : line?.text || ' '}
      </code>
    </div>
  )
}

export function SplitDiffView({ hunks }: { hunks: PatchHunk[] }) {
  const { t } = useTranslation()
  const fontFamily = useAtomValue(diffFontFamilyAtom)
  const rows = useMemo<Row[]>(() => {
    const result: Row[] = []
    for (const hunk of hunks) {
      result.push({ kind: 'hunk', header: hunk.header })
      for (const row of alignDiffLines(hunk.lines)) result.push(row.note ? { kind: 'note', text: row.note } : row)
    }
    return result
  }, [hunks])
  const rendered = useMemo(() => rows.map((row): { plain?: string; note?: boolean; row?: SplitRow; spans?: [WordSpan[], WordSpan[]] } => 'kind' in row
    ? { plain: row.kind === 'hunk' ? row.header : row.text, note: row.kind === 'note' }
    : { row, spans: row.left?.kind === 'remove' && row.right?.kind === 'add' ? highlightWords(row.left.text, row.right.text) : undefined }), [rows])
  const pane = (side: 'old' | 'new') => (
    <div className="min-w-0 overflow-x-auto overscroll-x-contain [scrollbar-width:thin] [scrollbar-color:rgba(255,255,255,0.15)_transparent]" data-diff-pane={side}>
      <div className="min-w-max">
        {rendered.map((entry, i) => entry.row
          ? <GutterCell key={i} line={side === 'old' ? entry.row.left : entry.row.right} side={side} spans={side === 'old' ? entry.spans?.[0] : entry.spans?.[1]} />
          : <div key={i} aria-hidden={side === 'new'} className={entry.note ? 'px-3 text-[11px] text-white/40' : 'bg-sky-500/10 px-3 text-xs text-sky-200/70'}>{entry.plain}</div>)}
      </div>
    </div>
  )
  // Two independent 50% panes scroll horizontally within themselves; the
  // container never widens, and vertical scrolling stays with the outer
  // file list so the mouse wheel works over both sides.
  return <div className="text-sm leading-6" style={{ fontFamily }}>
    <div className="grid grid-cols-2 border-b border-white/10 bg-white/5 text-xs text-white/50">
      <span className="px-3 py-1">{t('gitCompare.left')}</span>
      <span className="border-l border-white/10 px-3 py-1">{t('gitCompare.right')}</span>
    </div>
    <div className="grid grid-cols-2 divide-x divide-white/10">{pane('old')}{pane('new')}</div>
  </div>
}
