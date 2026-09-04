import i18n from '../../i18n'
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'

registerTilePlugin({
  id: 'forward',
  get label() { return i18n.t('plugin.forward') },
  get description() { return i18n.t('plugin.forwardDesc') },
  render: (paneId, _context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId })
    return (
      <iframe
        src={`/forward?${p}`}
        title={`forward-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
})
