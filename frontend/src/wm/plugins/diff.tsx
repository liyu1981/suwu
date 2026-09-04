/**
 * Diff Tile Plugin
 * Side-by-side file diff viewer for the tiling window manager
 */

import i18n from '../../i18n'
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'
import type { ToolbarContext } from '../tilePlugins'

const toolBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-300'

function DiffToolbar({ paneId }: ToolbarContext) {
  return (
    <>
      <button
        type="button"
        onClick={() => {
          // Refresh the diff view
          const iframe = document.querySelector(`iframe[data-pane="${paneId}"]`) as HTMLIFrameElement
          iframe?.contentWindow?.postMessage({ type: 'diff-refresh' }, '*')
        }}
        aria-label="Refresh"
        title="Refresh diff"
        className={toolBtn}
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.418A6 6 0 1 1 8 2v1z"/>
          <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
        </svg>
      </button>
    </>
  )
}

registerTilePlugin({
  id: 'diff',
  get label() { return i18n.t('plugin.diff') },
  get description() { return i18n.t('plugin.diffDesc') },
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId })
    if (context?.initialPath) {
      p.set('file1', context.initialPath)
    }
    if (context?.params) {
      for (const [k, v] of Object.entries(context.params)) {
        p.set(k, v)
      }
    }
    return (
      <iframe
        src={`/diff?${p}`}
        title={`diff-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
  renderToolbar: (ctx) => <DiffToolbar {...ctx} />,
})
