import i18n from '../../i18n'
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'

registerTilePlugin({
  id: 'dropbox',
  get label() { return i18n.t('plugin.dropbox') },
  get description() { return i18n.t('plugin.dropboxDesc') },
  render: (paneId, context?: TileRenderContext) => {
    const params = new URLSearchParams({ pane: paneId })
    if (context?.params) {
      for (const [k, v] of Object.entries(context.params)) params.set(k, v)
    }
    return (
      <iframe
        src={`/dropbox?${params}`}
        title={`dropbox-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
})
