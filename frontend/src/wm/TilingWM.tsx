import { useCallback, useEffect } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { focusedIdAtom, layoutAtom } from './atoms'
import { closeAt, createLeaf, focusByOffset, leaves, splitAt, type Direction } from './layout'
import { wmAction, type WmAction } from './shortcuts'
import TilingNode from './TilingNode'

function action(name: WmAction, split: (d: Direction) => void, close: () => void, focusOffset: (o: number) => void) {
  switch (name) {
    case 'split-right':
      split('horizontal')
      break
    case 'split-below':
      split('vertical')
      break
    case 'close':
      close()
      break
    case 'focus-next':
      focusOffset(1)
      break
    case 'focus-prev':
      focusOffset(-1)
      break
  }
}

/**
 * A tiling window-manager-style page: a tree of terminal panes rendered as
 * same-origin iframes (each loading `/term` with a full-space ghostty
 * terminal), with split / close / focus / resize controls.
 */
export default function TilingWM() {
  const store = useStore()
  const layout = useAtomValue(layoutAtom)
  const focused = useAtomValue(focusedIdAtom)
  const setFocused = useSetAtom(focusedIdAtom)

  const split = useCallback(
    (dir: Direction) => {
      const cur = store.get(layoutAtom)
      // Empty layout: create first tile
      if (!cur) {
        const leaf = createLeaf()
        store.set(layoutAtom, leaf)
        store.set(focusedIdAtom, leaf.id)
        return
      }
      const f = store.get(focusedIdAtom)
      const target = f && leaves(cur).includes(f) ? f : leaves(cur)[0]
      if (!target) return
      const next = splitAt(cur, target, dir)
      store.set(layoutAtom, next)
      const ids = leaves(next).filter((id) => id !== target)
      store.set(focusedIdAtom, ids[ids.length - 1] ?? target)
    },
    [store],
  )

  const close = useCallback(() => {
    const cur = store.get(layoutAtom)
    if (!cur) return
    const f = store.get(focusedIdAtom)
    if (!f) return
    const next = closeAt(cur, f)
    store.set(layoutAtom, next)
    store.set(focusedIdAtom, leaves(next)[0] ?? '')
  }, [store])

  const focusOffset = useCallback(
    (off: number) => {
      const cur = store.get(layoutAtom)
      const f = store.get(focusedIdAtom)
      store.set(focusedIdAtom, focusByOffset(cur, f, off))
    },
    [store],
  )

  // Keep a valid focused leaf (initial state, after close, after storage load).
  useEffect(() => {
    const ids = leaves(layout)
    if (ids.length === 0) return
    if (!focused || !ids.includes(focused)) setFocused(ids[0])
  }, [layout, focused, setFocused])

  // Keyboard shortcuts when the parent window itself has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = wmAction(e)
      if (!a) return
      e.preventDefault()
      action(a, split, close, focusOffset)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [split, close, focusOffset])

  // Shortcuts relayed from a focused terminal iframe.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const a = e.data?.type === 'wm-shortcut' ? (e.data.action as WmAction) : undefined
      if (!a) return
      action(a, split, close, focusOffset)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [split, close, focusOffset])

  // Detect clicks into an iframe: the parent's document.activeElement becomes
  // the focused <iframe>, so we can track which pane is focused.
  useEffect(() => {
    const onFocus = () => {
      const el = document.activeElement as HTMLElement | null
      if (el?.tagName === 'IFRAME') {
        const id = el.getAttribute('data-pane')
        if (id) store.set(focusedIdAtom, id)
      }
    }
    window.addEventListener('focusin', onFocus)
    return () => window.removeEventListener('focusin', onFocus)
  }, [store])

  return (
    <div className="flex h-full w-full items-center justify-center">
      {layout ? (
        <TilingNode node={layout} />
      ) : (
        <button
          type="button"
          onClick={() => split('horizontal')}
          className="glass-control rounded-[6px] px-6 py-3 text-sm font-medium text-slate-300 glass-btn transition hover:text-white"
        >
          + New tile
        </button>
      )}
    </div>
  )
}
