import i18n from '../../i18n'
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'

registerTilePlugin({
  id: 'filebrowser',
  get label() { return i18n.t('plugin.fileBrowser') },
  get description() { return i18n.t('plugin.fileBrowserDesc') },
  render: (paneId, context?: TileRenderContext) => {
    const pathParam = context?.initialPath ? `&path=${encodeURIComponent(context.initialPath)}` : ''
    return (
      <iframe
        src={`/filebrowser?pane=${paneId}${pathParam}`}
        title={`filebrowser-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
})
