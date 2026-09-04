import i18n from '../../i18n'
import { registerTilePlugin } from '../tilePlugins'

registerTilePlugin({
  id: 'dropbox',
  get label() { return i18n.t('plugin.dropbox') },
  get description() { return i18n.t('plugin.dropboxDesc') },
  render: (paneId) => {
    return (
      <iframe
        src={`/dropbox?pane=${paneId}`}
        title={`dropbox-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
})
