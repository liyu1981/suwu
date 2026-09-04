import i18n from '../../i18n'
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'

registerTilePlugin({
  id: 'filebrowser',
  get label() { return i18n.t('plugin.fileBrowser') },
  get description() { return i18n.t('plugin.fileBrowserDesc') },
  supportedParams: [
    { key: 'path', label: 'Path', description: 'Initial directory to show' },
  ],
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId })
    const path = context?.initialPath ?? context?.params?.path
    if (path) p.set('path', path)
    return (
      <iframe
        src={`/filebrowser?${p}`}
        title={`filebrowser-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
})
