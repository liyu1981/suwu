import i18n from '../../i18n'
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'

registerTilePlugin({
  id: 'browser',
  get label() { return i18n.t('plugin.browser') },
  get description() { return i18n.t('plugin.browserDesc') },
  render: (paneId, _context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId })
    return (
      <iframe
        src={`/browser?${p}`}
        title={`browser-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
})
