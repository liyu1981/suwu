import i18n from '../../i18n'
import { registerTilePlugin } from '../tilePlugins'

registerTilePlugin({
  id: 'filebrowser',
  get label() { return i18n.t('plugin.fileBrowser') },
  get description() { return i18n.t('plugin.fileBrowserDesc') },
  render: (paneId) => (
    <iframe
      src={`/filebrowser?pane=${paneId}`}
      title={`filebrowser-${paneId}`}
      data-pane={paneId}
      className="h-full w-full border-0 bg-transparent"
    />
  ),
})
