import i18n from '../../i18n'
import { registerTilePlugin } from '../tilePlugins'

registerTilePlugin({
  id: 'viewer',
  get label() { return i18n.t('plugin.viewer') },
  get description() { return i18n.t('plugin.viewerDesc') },
  render: (paneId) => (
    <iframe
      src={`/viewer?pane=${paneId}`}
      title={`viewer-${paneId}`}
      data-pane={paneId}
      className="h-full w-full border-0 bg-transparent"
    />
  ),
})
