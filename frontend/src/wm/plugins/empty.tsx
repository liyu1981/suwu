import { useEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { focusedIdAtom } from '../atoms'
import i18n from '../../i18n'
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'

function EmptyTile({ paneId, onOpenPicker }: { paneId: string; onOpenPicker?: (id: string) => void }) {
  const setFocused = useSetAtom(focusedIdAtom)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const timer = setTimeout(() => {
      el.focus()
      setFocused(paneId)
    }, 50)
    return () => clearTimeout(timer)
  }, [paneId, setFocused])

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="flex h-full w-full items-center justify-center outline-none"
    >
      <button
        type="button"
        onClick={() => onOpenPicker?.(paneId)}
        className="glass-control rounded-[6px] px-6 py-3 text-sm font-medium text-slate-300 glass-btn transition hover:text-white"
      >
        {i18n.t('wm.openApp')}
      </button>
    </div>
  )
}

registerTilePlugin({
  id: 'empty',
  get label() { return i18n.t('plugin.empty') },
  get description() { return i18n.t('plugin.emptyDesc') },
  render: (paneId, context?: TileRenderContext) => (
    <EmptyTile paneId={paneId} onOpenPicker={context?.onOpenPicker} />
  ),
})
