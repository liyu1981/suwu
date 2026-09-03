/**
 * Git Graph Tile Plugin
 * Visual commit history viewer for the tiling window manager
 */

import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'
import type { ToolbarContext } from '../tilePlugins'

const toolBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-300'

function GitGraphToolbar({ paneId }: ToolbarContext) {
  return (
    <>
      <button
        type="button"
        onClick={() => {
          // Refresh the git graph
          const iframe = document.querySelector(`iframe[data-pane="${paneId}"]`) as HTMLIFrameElement
          iframe?.contentWindow?.postMessage({ type: 'gitgraph-refresh' }, '*')
        }}
        aria-label="Refresh"
        title="Refresh git graph"
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
  id: 'gitgraph',
  get label() { return 'Git Graph' },
  get description() { return 'Visual commit history' },
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId })
    if (context?.initialPath) {
      p.set('path', context.initialPath)
    }
    if (context?.params) {
      for (const [k, v] of Object.entries(context.params)) {
        p.set(k, v)
      }
    }
    return (
      <iframe
        src={`/gitgraph?${p}`}
        title={`gitgraph-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
  renderToolbar: (ctx) => <GitGraphToolbar {...ctx} />,
})
