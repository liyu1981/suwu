import i18n from '../../i18n'
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'

registerTilePlugin({
  id: 'viewer',
  get label() { return i18n.t('plugin.viewer') },
  get description() { return i18n.t('plugin.viewerDesc') },
  render: (paneId, context?: TileRenderContext) => {
    const pathParam = context?.initialPath ? `&path=${encodeURIComponent(context.initialPath)}` : ''
    return (
      <iframe
        src={`/viewer?pane=${paneId}${pathParam}`}
        title={`viewer-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
})
