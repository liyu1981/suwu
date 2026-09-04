import i18n from '../../i18n'
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'

registerTilePlugin({
  id: 'fileviewer',
  get label() { return i18n.t('plugin.viewer') },
  get description() { return i18n.t('plugin.viewerDesc') },
  supportedParams: [
    { key: 'path', label: 'Path', description: 'File path to view' },
  ],
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId })
    const path = context?.initialPath ?? context?.params?.path
    if (path) p.set('path', path)
    return (
      <iframe
        src={`/viewer?${p}`}
        title={`fileviewer-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
})
